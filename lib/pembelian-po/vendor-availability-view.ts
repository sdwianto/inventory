/**
 * Tampilan ketersediaan item PO di vendor — murni (tanpa DB), dipakai API & UI.
 * Sumber: cache `po.vendorAvailability` (dari sales) + kuantitas lokal (kirim/terima/batal).
 * Tidak memuat stok vendor, nama supplier, atau nomor PO supplier.
 */

import { calendarDateKey } from '@/lib/calendar-date';

export const VENDOR_AVAILABILITY_TTL_MS = 5 * 60_000;

/** Status PO yang masih menunggu barang dari vendor — ketersediaan ditarik dari sales. */
export const REMOTE_AVAILABILITY_STATUSES = new Set([
  'SUBMITTED',
  'CONFIRMED',
  'PARTIAL_CANCELLED',
  'PARTIAL_SHIPPED',
]);

/** Status PO yang cukup diturunkan dari data lokal (sudah dikirim/diterima). */
export const LOCAL_AVAILABILITY_STATUSES = new Set([
  'SHIPPED',
  'PARTIAL_RECEIVED',
  'RECEIVED',
  'INVOICED',
]);

export type VendorSegmentState = 'OK' | 'NO_SO' | 'UNSUPPORTED' | 'NOT_LINKED' | 'ERROR';

export type VendorAvailabilityLine = {
  qtyOrdered: number;
  qtyTerkirim: number;
  qtySiap: number;
  reserved: boolean;
  qtyDiadakan: number;
  etaDiadakan: string | null;
  menungguPersetujuan: boolean;
  qtyBelum: number;
  qtyDibatalkan: number;
};

export type VendorAvailabilitySegment = {
  vendorTenantId: string;
  state: VendorSegmentState;
  salesOrderId?: string | null;
  noSO?: string | null;
  soStatus?: string | null;
  computedAt?: Date | string | null;
  fetchedAt?: Date | string | null;
  error?: string | null;
  lines?: Record<string, VendorAvailabilityLine>;
};

export type VendorAvailabilityCache = {
  fetchedAt?: Date | string | null;
  vendors?: Record<string, VendorAvailabilitySegment>;
};

export type ItemAvailabilityStatus =
  | 'TERKIRIM'
  | 'SIAP'
  | 'DIADAKAN'
  | 'BELUM'
  | 'DIBATALKAN'
  | 'TIDAK_DIKETAHUI';

export type PoItemAvailabilityView = {
  lineId: string;
  status: ItemAvailabilityStatus;
  qtyOrdered: number;
  qtyTerkirim: number;
  qtySiap: number;
  qtyDiadakan: number;
  qtyBelum: number;
  qtyDibatalkan: number;
  etaDiadakan: string | null;
  /** ETA pengadaan melewati tanggal kedatangan PO. */
  etaLewatKedatangan: boolean;
  menungguPersetujuan: boolean;
  reserved: boolean;
  source: 'VENDOR' | 'LOCAL' | 'NONE';
};

export type PoAvailabilitySummary = {
  total: number;
  terkirim: number;
  siap: number;
  diadakan: number;
  belum: number;
  dibatalkan: number;
  tidakDiketahui: number;
  etaLewatKedatangan: number;
};

export type PoAvailabilityView = {
  applicable: boolean;
  mode: 'REMOTE' | 'LOCAL' | 'NONE';
  fetchedAt: string | null;
  stale: boolean;
  vendors: Array<{
    vendorTenantId: string;
    state: VendorSegmentState;
    noSO: string | null;
    computedAt: string | null;
    error: string | null;
  }>;
  items: PoItemAvailabilityView[];
  summary: PoAvailabilitySummary;
};

const EPS = 1e-6;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Kunci aman untuk path Mongo (`vendorAvailability.vendors.<key>`). */
export function vendorAvailabilityKey(vendorTenantId: string): string {
  return String(vendorTenantId || '').trim().replace(/[.$]/g, '_') || '_';
}

type PoLike = {
  status?: unknown;
  vendorTenantId?: unknown;
  tanggalKedatangan?: unknown;
  items?: unknown;
  vendorAvailability?: unknown;
};

type ItemLike = {
  lineId?: unknown;
  qty?: unknown;
  qtyShipped?: unknown;
  qtyReceived?: unknown;
  qtyShortClosed?: unknown;
  cancelled?: unknown;
  vendorTenantId?: unknown;
};

function findVendorLine(
  cache: VendorAvailabilityCache | null,
  lineId: string,
): VendorAvailabilityLine | null {
  if (!cache?.vendors || !lineId) return null;
  for (const seg of Object.values(cache.vendors)) {
    const line = seg?.lines?.[lineId];
    if (line) return line;
  }
  return null;
}

/**
 * Gabungkan data vendor dengan kuantitas lokal. Kiriman lokal yang lebih baru dari
 * snapshot vendor mengurangi porsi siap → diadakan → belum (barang dikirim dari stok siap).
 */
export function buildItemAvailability(
  item: ItemLike,
  vendorLine: VendorAvailabilityLine | null,
  arrivalKey: string | null,
): PoItemAvailabilityView {
  const lineId = String(item.lineId || '');
  const qtyOrdered = num(item.qty) || num(vendorLine?.qtyOrdered);
  const localTerkirim = Math.max(num(item.qtyShipped), num(item.qtyReceived));
  const localBatal = item.cancelled
    ? qtyOrdered
    : Math.min(qtyOrdered, num(item.qtyShortClosed));

  const qtyTerkirim = Math.min(qtyOrdered, Math.max(localTerkirim, num(vendorLine?.qtyTerkirim)));
  const qtyDibatalkan = Math.min(
    Math.max(0, qtyOrdered - qtyTerkirim),
    Math.max(localBatal, num(vendorLine?.qtyDibatalkan)),
  );
  const remaining = Math.max(0, qtyOrdered - qtyTerkirim - qtyDibatalkan);

  let qtySiap = num(vendorLine?.qtySiap);
  let qtyDiadakan = num(vendorLine?.qtyDiadakan);
  let qtyBelum = num(vendorLine?.qtyBelum);
  let excess = qtySiap + qtyDiadakan + qtyBelum - remaining;
  if (excess > EPS) {
    const cut = (v: number) => {
      const c = Math.min(v, excess);
      excess -= c;
      return v - c;
    };
    qtySiap = cut(qtySiap);
    qtyDiadakan = cut(qtyDiadakan);
    qtyBelum = cut(qtyBelum);
  }

  const etaDiadakan = qtyDiadakan > EPS ? (vendorLine?.etaDiadakan || null) : null;
  const etaKey = etaDiadakan ? calendarDateKey(etaDiadakan) : '';
  const etaLewatKedatangan = Boolean(arrivalKey && etaKey && etaKey > arrivalKey);

  let status: ItemAvailabilityStatus;
  if (item.cancelled || (qtyOrdered > EPS && qtyDibatalkan >= qtyOrdered - EPS)) {
    status = 'DIBATALKAN';
  } else if (remaining <= EPS && qtyOrdered > EPS) {
    status = 'TERKIRIM';
  } else if (qtyBelum > EPS) {
    status = 'BELUM';
  } else if (qtyDiadakan > EPS) {
    status = 'DIADAKAN';
  } else if (qtySiap > EPS) {
    status = 'SIAP';
  } else {
    status = 'TIDAK_DIKETAHUI';
  }

  return {
    lineId,
    status,
    qtyOrdered,
    qtyTerkirim,
    qtySiap,
    qtyDiadakan,
    qtyBelum,
    qtyDibatalkan,
    etaDiadakan,
    etaLewatKedatangan,
    menungguPersetujuan: Boolean(vendorLine?.menungguPersetujuan) && qtyDiadakan > EPS,
    reserved: Boolean(vendorLine?.reserved) && qtySiap > EPS,
    source: vendorLine ? 'VENDOR' : (status === 'TIDAK_DIKETAHUI' ? 'NONE' : 'LOCAL'),
  };
}

export function summarizeAvailability(items: PoItemAvailabilityView[]): PoAvailabilitySummary {
  const s: PoAvailabilitySummary = {
    total: items.length,
    terkirim: 0,
    siap: 0,
    diadakan: 0,
    belum: 0,
    dibatalkan: 0,
    tidakDiketahui: 0,
    etaLewatKedatangan: 0,
  };
  for (const it of items) {
    if (it.status === 'TERKIRIM') s.terkirim += 1;
    else if (it.status === 'SIAP') s.siap += 1;
    else if (it.status === 'DIADAKAN') s.diadakan += 1;
    else if (it.status === 'BELUM') s.belum += 1;
    else if (it.status === 'DIBATALKAN') s.dibatalkan += 1;
    else s.tidakDiketahui += 1;
    if (it.etaLewatKedatangan) s.etaLewatKedatangan += 1;
  }
  return s;
}

export function buildPoAvailabilityView(po: PoLike, now: Date = new Date()): PoAvailabilityView {
  const status = String(po.status || '');
  const mode: PoAvailabilityView['mode'] = REMOTE_AVAILABILITY_STATUSES.has(status)
    ? 'REMOTE'
    : LOCAL_AVAILABILITY_STATUSES.has(status) ? 'LOCAL' : 'NONE';
  const cache = (po.vendorAvailability && typeof po.vendorAvailability === 'object'
    ? po.vendorAvailability
    : null) as VendorAvailabilityCache | null;
  const fetchedAt = iso(cache?.fetchedAt);
  const stale = mode === 'REMOTE'
    && (!fetchedAt || now.getTime() - new Date(fetchedAt).getTime() > VENDOR_AVAILABILITY_TTL_MS);

  const arrivalKey = po.tanggalKedatangan ? calendarDateKey(po.tanggalKedatangan) || null : null;
  const rawItems = (Array.isArray(po.items) ? po.items : []) as ItemLike[];
  const items = mode === 'NONE'
    ? []
    : rawItems.map((it) => buildItemAvailability(
      it,
      mode === 'REMOTE' ? findVendorLine(cache, String(it.lineId || '')) : null,
      arrivalKey,
    ));

  const vendors = Object.values(cache?.vendors || {}).map((seg) => ({
    vendorTenantId: String(seg.vendorTenantId || ''),
    state: seg.state,
    noSO: seg.noSO ? String(seg.noSO) : null,
    computedAt: iso(seg.computedAt),
    error: seg.error ? String(seg.error) : null,
  }));

  return {
    applicable: mode !== 'NONE',
    mode,
    fetchedAt,
    stale,
    vendors,
    items,
    summary: summarizeAvailability(items),
  };
}
