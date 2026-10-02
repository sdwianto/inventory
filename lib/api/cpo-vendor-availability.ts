/**
 * Ketersediaan item Customer PO di vendor (sales.app) — pull Category B, cache di dokumen PO,
 * push webhook `sales_order.availability_changed`, dan refresh terjadwal.
 */

import type { Db } from 'mongodb';
import type { JsonObject } from '@/types/json';
import { resolveSalesApiAccess } from '@/lib/api/integration-links';
import { integrationCorrelationId } from '@/lib/api/integration-common';
import { createIntegrationClient, type IntegrationClient } from '@/lib/integration/client';
import { IntegrationError } from '@/lib/integration/errors';
import { isSupersededVendorSo } from '@/lib/api/cpo-line-cancel-sync';
import { logger } from '@/lib/api/logger';
import {
  REMOTE_AVAILABILITY_STATUSES,
  VENDOR_AVAILABILITY_TTL_MS,
  vendorAvailabilityKey,
  type VendorAvailabilityLine,
  type VendorAvailabilitySegment,
  type VendorSegmentState,
} from '@/lib/pembelian-po/vendor-availability-view';

const PO_COLLECTION = 'customer_purchase_orders';

/** Refresh manual lebih rapat dari ini ditolak (anti-spam tombol Perbarui). */
export const VENDOR_AVAILABILITY_MIN_REFRESH_MS = 30_000;
/** Klaim refresh — cegah beberapa request menarik PO yang sama bersamaan. */
const REFRESH_CLAIM_MS = 20_000;

type AvailabilityClient = Pick<IntegrationClient, 'getCustomerPoAvailability'>;

export type RefreshAvailabilityResult = {
  refreshed: boolean;
  skipped?: 'status' | 'fresh' | 'rate_limited' | 'in_progress' | 'no_vendor';
  po: JsonObject;
};

type PoItem = JsonObject & {
  lineId?: string;
  vendorStokId?: string;
  vendorTenantId?: string;
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Vendor yang punya SO aktif untuk PO ini. */
export function availabilityVendorTargets(po: JsonObject): string[] {
  const subs = Array.isArray(po.vendorSubmissions) ? po.vendorSubmissions as JsonObject[] : [];
  const out = new Set<string>();
  for (const s of subs) {
    const vid = String(s.vendorTenantId || '').trim();
    const st = String(s.status || 'SYNCED').toUpperCase();
    if (vid && st !== 'FAILED' && st !== 'CANCELLED') out.add(vid);
  }
  if (!out.size && !subs.length) {
    const vid = String(po.vendorTenantId || '').trim();
    if (vid && vid !== 'multi') out.add(vid);
  }
  return [...out];
}

function itemVendor(po: JsonObject, item: PoItem): string {
  return String(item.vendorTenantId || (po.vendorTenantId === 'multi' ? '' : po.vendorTenantId) || '').trim();
}

/** Tanggal ETA dari sales (`YYYY-MM-DD` atau ISO) → kunci hari WIB. */
function etaKey(v: unknown): string | null {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = toDate(v);
  return d ? wibDateKey(d) : null;
}

function parseLine(raw: JsonObject): VendorAvailabilityLine {
  return {
    qtyOrdered: num(raw.qtyOrdered),
    qtyTerkirim: num(raw.qtyTerkirim),
    qtySiap: num(raw.qtySiap),
    reserved: raw.reserved === true,
    qtyDiadakan: num(raw.qtyDiadakan),
    etaDiadakan: etaKey(raw.etaDiadakan),
    menungguPersetujuan: raw.menungguPersetujuan === true,
    qtyBelum: num(raw.qtyBelum),
    qtyDibatalkan: num(raw.qtyDibatalkan),
  };
}

const QTY_FIELDS = ['qtyOrdered', 'qtyTerkirim', 'qtySiap', 'qtyDiadakan', 'qtyBelum', 'qtyDibatalkan'] as const;

/** Baris SO yang dipecah (satu baris PO → beberapa baris SO) dijumlahkan. */
function mergeLines(a: VendorAvailabilityLine, b: VendorAvailabilityLine): VendorAvailabilityLine {
  const out = { ...a };
  for (const f of QTY_FIELDS) out[f] = a[f] + b[f];
  out.reserved = (a.qtySiap <= 0 || a.reserved) && (b.qtySiap <= 0 || b.reserved) && out.qtySiap > 0;
  out.menungguPersetujuan = a.menungguPersetujuan || b.menungguPersetujuan;
  out.etaDiadakan = [a.etaDiadakan, b.etaDiadakan].filter(Boolean).sort().pop() ?? null;
  return out;
}

function normUnit(v: unknown): string {
  return String(v || '').trim().toUpperCase();
}

/**
 * Petakan baris SO → `items[].lineId`. Utama via `customerPoLineId`;
 * fallback `stokId` hanya bila produk itu unik di antara item vendor tsb dan satuannya sama.
 * Satuan SO berbeda dari satuan PO → qty diskalakan ke satuan PO (qty PO ÷ qty pesan SO).
 */
export function mapAvailabilityLines(
  po: JsonObject,
  vendorTenantId: string,
  rawLines: JsonObject[],
): Record<string, VendorAvailabilityLine> {
  const items = (Array.isArray(po.items) ? po.items : []) as PoItem[];
  const vendorItems = items.filter((it) => {
    const v = itemVendor(po, it);
    return !v || v === vendorTenantId;
  });
  const byLineId = new Map(vendorItems.map((it) => [String(it.lineId || ''), it]));
  const byStok = new Map<string, PoItem[]>();
  for (const it of vendorItems) {
    const sid = String(it.vendorStokId || '').trim();
    if (!sid) continue;
    byStok.set(sid, [...(byStok.get(sid) || []), it]);
  }

  const grouped = new Map<string, { item: PoItem; line: VendorAvailabilityLine; unitDiffers: boolean }>();
  for (const raw of rawLines) {
    const cpoLineId = String(raw.customerPoLineId || '').trim();
    const rawUnit = normUnit(raw.satuan);
    let target = cpoLineId ? byLineId.get(cpoLineId) : undefined;
    if (!target && !cpoLineId) {
      const candidates = byStok.get(String(raw.stokId || '').trim()) || [];
      if (candidates.length === 1 && (!rawUnit || rawUnit === normUnit(candidates[0].satuan))) target = candidates[0];
    }
    const lineId = String(target?.lineId || '');
    if (!target || !lineId) continue;
    const line = parseLine(raw);
    const unitDiffers = !!rawUnit && !!normUnit(target.satuan) && rawUnit !== normUnit(target.satuan);
    const prev = grouped.get(lineId);
    grouped.set(lineId, prev
      ? { item: target, line: mergeLines(prev.line, line), unitDiffers: prev.unitDiffers || unitDiffers }
      : { item: target, line, unitDiffers });
  }

  const out: Record<string, VendorAvailabilityLine> = {};
  for (const [lineId, { item, line, unitDiffers }] of grouped) {
    const poQty = num(item.qty);
    if (unitDiffers && poQty > 0 && line.qtyOrdered > 0) {
      const k = poQty / line.qtyOrdered;
      const scaled = { ...line };
      for (const f of QTY_FIELDS) scaled[f] = Math.round(line[f] * k * 1000) / 1000;
      out[lineId] = scaled;
    } else {
      out[lineId] = line;
    }
  }
  return out;
}

function soRefOf(body: JsonObject, vendorTenantId: string) {
  return {
    salesOrderId: body.salesOrderId ? String(body.salesOrderId) : undefined,
    noSO: body.noSO ? String(body.noSO) : undefined,
    vendorTenantId,
  };
}

function responseBody(raw: Record<string, unknown>): JsonObject {
  const inner = raw.data;
  return (inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : raw) as JsonObject;
}

async function fetchVendorSegment(
  db: Db,
  po: JsonObject,
  vendorTenantId: string,
  client: AvailabilityClient,
  now: Date,
): Promise<VendorAvailabilitySegment> {
  const tenantId = String(po.tenantId || '');
  const base = { vendorTenantId, fetchedAt: now };
  const access = await resolveSalesApiAccess(db, tenantId, vendorTenantId);
  if (!access) return { ...base, state: 'NOT_LINKED', error: 'Belum terhubung ke sales.app' };

  try {
    const raw = await client.getCustomerPoAvailability({
      salesAppUrl: access.salesAppUrl,
      apiKey: access.salesApiKey,
      correlationId: integrationCorrelationId(String(po.id || ''), 'po-availability'),
      customerTenantId: tenantId,
      customerPoId: String(po.id || ''),
      noPO: po.noPO ? String(po.noPO) : undefined,
      vendorTenantId,
    });
    const body = responseBody(raw);
    const soRef = soRefOf(body, vendorTenantId);
    // SO lama yang digantikan edit PO (sales masih mengembalikannya sebelum SO baru dibuat).
    if (isSupersededVendorSo(po, soRef)) return { ...base, state: 'NO_SO', error: null, lines: {} };
    return {
      ...base,
      state: 'OK',
      salesOrderId: soRef.salesOrderId || null,
      noSO: body.noSO ? String(body.noSO) : null,
      soStatus: body.soStatus ? String(body.soStatus) : null,
      computedAt: toDate(body.computedAt) || now,
      error: null,
      lines: mapAvailabilityLines(
        po,
        vendorTenantId,
        (Array.isArray(body.lines) ? body.lines : []) as JsonObject[],
      ),
    };
  } catch (e) {
    if (e instanceof IntegrationError && e.httpStatus === 404) {
      const state: VendorSegmentState = e.code === 'SO_NOT_FOUND' ? 'NO_SO' : 'UNSUPPORTED';
      return { ...base, state, error: null, lines: {} };
    }
    return { ...base, state: 'ERROR', error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Tulis satu segmen vendor. Segmen OK hanya menimpa bila `computedAt` tidak lebih lama
 * dari yang tersimpan (push webhook bisa tiba sebelum pull selesai). ERROR mempertahankan
 * baris terakhir agar UI tetap menampilkan data terakhir yang diketahui.
 */
async function writeSegment(
  db: Db,
  poFilter: JsonObject,
  seg: VendorAvailabilitySegment,
): Promise<boolean> {
  const path = `vendorAvailability.vendors.${vendorAvailabilityKey(seg.vendorTenantId)}`;
  if (seg.state === 'ERROR') {
    const res = await db.collection(PO_COLLECTION).updateOne(poFilter, {
      $set: {
        [`${path}.vendorTenantId`]: seg.vendorTenantId,
        [`${path}.state`]: 'ERROR',
        [`${path}.error`]: seg.error ?? null,
        [`${path}.fetchedAt`]: seg.fetchedAt,
      },
    });
    return res.modifiedCount > 0;
  }
  // Segmen non-OK (NO_SO, NOT_LINKED, …) tidak punya computedAt: bandingkan dengan waktu tarik,
  // agar push yang lebih baru tidak tertimpa hasil tarik yang dimulai lebih dulu.
  const computedAt = toDate(seg.computedAt);
  const guardAt = computedAt ?? toDate(seg.fetchedAt);
  const filter = guardAt
    ? {
      ...poFilter,
      $or: [
        { [`${path}.computedAt`]: { $exists: false } },
        { [`${path}.computedAt`]: null },
        { [`${path}.computedAt`]: { $lte: guardAt } },
      ],
    }
    : poFilter;
  const res = await db.collection(PO_COLLECTION).updateOne(filter, {
    $set: { [path]: { ...seg, computedAt: computedAt ?? null } },
  });
  return res.modifiedCount > 0;
}

/**
 * Tarik ketersediaan dari sales untuk semua vendor PO lalu simpan ke cache.
 * `force` = tombol Perbarui (tetap dibatasi MIN_REFRESH); tanpa `force` hormati TTL.
 */
export async function refreshPoVendorAvailability(
  db: Db,
  po: JsonObject,
  opts: { force?: boolean; now?: Date; maxAgeMs?: number; client?: AvailabilityClient } = {},
): Promise<RefreshAvailabilityResult> {
  const now = opts.now ?? new Date();
  if (!REMOTE_AVAILABILITY_STATUSES.has(String(po.status || ''))) {
    return { refreshed: false, skipped: 'status', po };
  }
  const targets = availabilityVendorTargets(po);
  if (!targets.length) return { refreshed: false, skipped: 'no_vendor', po };

  const cache = (po.vendorAvailability || {}) as JsonObject;
  const last = toDate(cache.fetchedAt);
  const age = last ? now.getTime() - last.getTime() : Infinity;
  const maxAge = opts.maxAgeMs ?? VENDOR_AVAILABILITY_TTL_MS;
  if (!opts.force && age < maxAge) return { refreshed: false, skipped: 'fresh', po };
  if (opts.force && age < VENDOR_AVAILABILITY_MIN_REFRESH_MS) {
    return { refreshed: false, skipped: 'rate_limited', po };
  }

  const poFilter = { id: String(po.id || ''), tenantId: String(po.tenantId || '') };
  const claim = await db.collection(PO_COLLECTION).updateOne(
    {
      ...poFilter,
      $or: [
        { 'vendorAvailability.refreshingUntil': { $exists: false } },
        { 'vendorAvailability.refreshingUntil': null },
        { 'vendorAvailability.refreshingUntil': { $lt: now } },
      ],
    },
    { $set: { 'vendorAvailability.refreshingUntil': new Date(now.getTime() + REFRESH_CLAIM_MS) } },
  );
  if (!claim.matchedCount) return { refreshed: false, skipped: 'in_progress', po };

  const client = opts.client ?? createIntegrationClient(db);
  try {
    const segments = await Promise.all(
      targets.map((vid) => fetchVendorSegment(db, po, vid, client, now)),
    );
    for (const seg of segments) await writeSegment(db, poFilter, seg);
  } finally {
    await db.collection(PO_COLLECTION).updateOne(poFilter, {
      $set: { 'vendorAvailability.fetchedAt': now, 'vendorAvailability.refreshingUntil': null },
    });
  }

  const fresh = await db.collection(PO_COLLECTION).findOne(poFilter);
  return { refreshed: true, po: (fresh || po) as JsonObject };
}

/** Terapkan push `sales_order.availability_changed` (payload sama dengan respons pull). */
export async function applyVendorAvailabilityPush(
  db: Db,
  customerTenantId: string,
  payload: JsonObject,
  vendorTenantIdFromEnvelope?: string,
): Promise<Record<string, unknown>> {
  const customerPoId = String(payload.customerPoId || '').trim();
  const noPO = String(payload.noPO || '').trim();
  // Payload tanpa referensi PO tidak akan pernah berhasil diulang — lewati, jangan gagal-ulang.
  if (!customerPoId && !noPO) return { action: 'skipped', reason: 'missing_po_ref' };

  const po = await db.collection(PO_COLLECTION).findOne({
    tenantId: customerTenantId,
    ...(customerPoId ? { id: customerPoId } : { noPO }),
  }) as JsonObject | null;
  if (!po) return { action: 'skipped', reason: 'po_not_found' };
  if (!REMOTE_AVAILABILITY_STATUSES.has(String(po.status || ''))) {
    return { action: 'skipped', reason: 'status', status: po.status };
  }

  const vendorTenantId = String(vendorTenantIdFromEnvelope || payload.vendorTenantId || '').trim();
  if (!vendorTenantId || !availabilityVendorTargets(po).includes(vendorTenantId)) {
    return { action: 'skipped', reason: 'vendor_not_on_po' };
  }
  const soRef = soRefOf(payload, vendorTenantId);
  if (isSupersededVendorSo(po, soRef)) {
    return { action: 'skipped', reason: 'superseded_so', salesOrderId: soRef.salesOrderId ?? null };
  }

  const now = new Date();
  const applied = await writeSegment(db, { id: String(po.id), tenantId: customerTenantId }, {
    vendorTenantId,
    state: 'OK',
    salesOrderId: soRef.salesOrderId || null,
    noSO: payload.noSO ? String(payload.noSO) : null,
    soStatus: payload.soStatus ? String(payload.soStatus) : null,
    computedAt: toDate(payload.computedAt) || now,
    fetchedAt: now,
    error: null,
    lines: mapAvailabilityLines(
      po,
      vendorTenantId,
      (Array.isArray(payload.lines) ? payload.lines : []) as JsonObject[],
    ),
  });
  if (applied) {
    await db.collection(PO_COLLECTION).updateOne(
      { id: String(po.id), tenantId: customerTenantId },
      { $set: { 'vendorAvailability.fetchedAt': now } },
    );
  }
  return { action: applied ? 'applied' : 'stale_ignored', customerPoId: po.id };
}

const WIB_OFFSET_MS = 7 * 3600_000;

export function wibDateKey(d: Date): string {
  return new Date(d.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Filter `tanggalKedatangan` dalam rentang hari kalender [fromKey, toKey] (inklusif).
 * Data tersimpan campuran: Date (UTC noon, jalur form) dan string `YYYY-MM-DD`
 * (PO otomatis dari kekurangan rencana produksi).
 */
export function arrivalDateRangeFilter(fromKey: string, toKey: string): JsonObject {
  return {
    $or: [
      {
        tanggalKedatangan: {
          $gte: new Date(`${fromKey}T00:00:00.000Z`),
          $lte: new Date(`${toKey}T23:59:59.999Z`),
        },
      },
      { tanggalKedatangan: { $gte: fromKey, $lte: `${toKey}\uffff` } },
    ],
  };
}

/** PO terlambat (kedatangan sudah lewat tapi masih terbuka) tetap di-refresh sampai sekian hari. */
const REFRESH_OVERDUE_DAYS = 30;

/**
 * Job terjadwal: refresh PO terbuka dengan kedatangan −30 s/d +14 hari
 * yang cache-nya lebih tua dari `maxAgeMs` (default 25 menit).
 */
export async function runPoVendorAvailabilityRefresh(
  db: Db,
  payload: { tenantId?: string; allTenants?: boolean; limit?: number; maxAgeMs?: number } = {},
  opts: { now?: Date; client?: AvailabilityClient } = {},
): Promise<Record<string, unknown>> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(Number(payload.limit) || 500, 1), 2000);
  const maxAgeMs = Number(payload.maxAgeMs) || 25 * 60_000;
  const fromKey = wibDateKey(new Date(now.getTime() - REFRESH_OVERDUE_DAYS * 86_400_000));
  const toKey = wibDateKey(new Date(now.getTime() + 14 * 86_400_000));
  const staleBefore = new Date(now.getTime() - maxAgeMs);

  const filter: JsonObject = {
    status: { $in: [...REMOTE_AVAILABILITY_STATUSES] },
    $and: [
      arrivalDateRangeFilter(fromKey, toKey),
      {
        $or: [
          { 'vendorAvailability.fetchedAt': { $exists: false } },
          { 'vendorAvailability.fetchedAt': { $lt: staleBefore } },
        ],
      },
    ],
  };
  if (!payload.allTenants && payload.tenantId && payload.tenantId !== 'system') {
    filter.tenantId = payload.tenantId;
  }

  const pos = await db.collection(PO_COLLECTION)
    .find(filter)
    .sort({ 'vendorAvailability.fetchedAt': 1, _id: 1 })
    .limit(limit + 1)
    .toArray() as JsonObject[];
  const truncated = pos.length > limit;
  if (truncated) {
    pos.length = limit;
    logger.warn('po_vendor_availability_refresh_truncated', { limit });
  }

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  for (const po of pos) {
    try {
      const r = await refreshPoVendorAvailability(db, po, { now: opts.now ?? new Date(), maxAgeMs, client: opts.client });
      if (r.refreshed) refreshed += 1;
      else skipped += 1;
    } catch (e) {
      failed += 1;
      logger.warn('po_vendor_availability_refresh_failed', { poId: po.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { scanned: pos.length, refreshed, skipped, failed, truncated };
}
