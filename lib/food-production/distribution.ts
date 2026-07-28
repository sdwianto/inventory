/**
 * Distribution Order / Packing list — ADR-001 Phase 5 / Sprint 19.
 * Packing dari RPN (rencana) atau HSL (actual) ke titik layanan.
 * DRAFT → APPROVED (Terjadwal, nomor DST) → PROCESSING (Dikirim) → COMPLETED (Selesai).
 * Nomor DST baru diterbitkan saat jadi Terjadwal (setelah HSL ada).
 * Retur dicatat per titik (qtyDikembalikan), bukan status dokumen global.
 * W2-2: APPROVED→PROCESSING posts FG OUT + FEFO when linked HSL has FG stock;
 * FOOD_TRAY-only (no FG on HSL) tetap tanpa mutasi stok.
 *
 * --- Inventory Dispatch Document (mental model, Sprint 4 STEP 1) ---
 * docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md: dokumen ini sesungguhnya dua konsep
 * yang tercampur. Header + lines[] (DistributionLine) + fefoConsume[]/fefoRestore[] =
 * Dispatch (barang keluar gudang — tetap domain Inventory, dipakai 3 script FEFO yang
 * sudah diverifikasi HANYA menyentuh field-field ini). loadings[]/armadas[] (rute,
 * kendaraan, jam drop) = Delivery (domain Logistics, belum diekstrak).
 * Historical collection name: distribution_orders (belum di-rename — rename tipe/collection
 * adalah langkah terpisah, menunggu tim nyaman dengan mental model ini, bukan otomatis).
 */

/** Alasan blok create DST dari RPN (HSL sudah ada / DST PLAN masih aktif). */
export function planDistCreateBlockedReason(input: {
  planNo: string;
  hslNo?: string | null;
  openDstNo?: string | null;
  openDstStatus?: string | null;
}): string | null {
  if (input.hslNo) {
    return `Rencana sudah punya HSL ${input.hslNo} — buat DST dari Hasil Produksi`;
  }
  if (input.openDstNo) {
    const st = input.openDstStatus ? ` (${input.openDstStatus})` : '';
    const label = String(input.openDstNo).trim() || 'Draft';
    return `Rencana ${input.planNo} masih punya DST ${label}${st} — selesaikan / batalkan dulu`;
  }
  return null;
}

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import { FP_DEFAULT_TRANSITIONS } from '@/lib/food-production/document';
import { roundQty } from '@/lib/food-production/material-requirement';
import {
  KATEGORI_PORSI_OPTIONS,
  compareJamKirim,
  normalizeJamKirim,
  routeJamKirim,
  sumPorsiByKategori,
  type ServicePointPorsiByKategori,
} from '@/lib/food-production/service-point';
import type { KategoriPorsi } from '@/lib/food-production/production-plan';

export const DISTRIBUTION_ORDERS_COLLECTION = 'distribution_orders';

/** Satu set makanan per porsi (MBG) — bukan per resep. */
export const FOOD_TRAY_ID = 'FOOD_TRAY';
export const FOOD_TRAY_LABEL = 'Food Tray';

export type DistributionSourceType = 'PLAN' | 'RESULT';
export type DistributionStatus = FpDocStatus;

export interface DistributionLine {
  servicePointId: string;
  servicePointKode?: string;
  servicePointNama?: string;
  /** Kapasitas titik layanan saat packing dibuat. */
  kapasitasPorsi?: number;
  /** Snapshot jam kirim titik (HH:mm). */
  jamKirim?: string;
  /** Snapshot kategori porsi titik, diskalakan ke qtyPorsi bila kapasitas ada. */
  porsiByKategori?: ServicePointPorsiByKategori;
  /** Armada yang membawa baris ini (jika di-assign). */
  armadaId?: string;
  menuId?: string;
  menuKode?: string;
  menuNama?: string;
  /** Identitas baris MBG bila rencana langsung resep (tanpa menu / FG). */
  recipeId?: string;
  recipeKode?: string;
  recipeNama?: string;
  finishedGoodProductId?: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  /** Alokasi rencana (saat disiapkan). */
  qtyPorsi: number;
  /** Actual dikirim ke titik. */
  qtyDikirim?: number;
  /** Actual diterima di titik. */
  qtyDiterima?: number;
  /** Actual dikembalikan dari titik (bukan status dokumen). */
  qtyDikembalikan?: number;
  notes?: string;
}

/** Jam pengiriman dalam satu stop (snapshot dari master titik.drops). */
export interface DistributionStopDrop {
  dropId: string;
  /** Jam pengiriman (HH:mm). */
  jamKirim?: string;
  /** Keterangan singkat opsional. */
  label?: string;
  qtyPorsi: number;
  porsiByKategori?: ServicePointPorsiByKategori;
}

/** Satu stop dalam rute armada (urut jam drop / jam pengiriman). */
export interface DistributionArmadaStop {
  urutan: number;
  servicePointId: string;
  servicePointKode?: string;
  servicePointNama?: string;
  jamKirim?: string;
  kapasitasPorsi?: number;
  qtyPorsi: number;
  porsiByKategori?: ServicePointPorsiByKategori;
  drops?: DistributionStopDrop[];
}

/** Armada + rute + ringkasan kategori porsi pada dokumen DST. */
export interface DistributionArmada {
  armadaId: string;
  armadaKode?: string;
  armadaNama?: string;
  platNomor?: string;
  kapasitasPorsi?: number;
  stops: DistributionArmadaStop[];
  porsiByKategori: ServicePointPorsiByKategori;
  qtyPorsiTotal: number;
  servicePointCount: number;
}

/** Gelombang loading (start/max) berisi satu atau lebih armada. */
export interface DistributionLoading {
  urutan: number;
  label?: string;
  jamStart: string;
  jamMax: string;
  armadas: DistributionArmada[];
  qtyPorsiTotal: number;
  servicePointCount: number;
}

export interface DistributionOrderDoc {
  id: string;
  tenantId: string;
  /** Kosong sampai Terjadwal — nomor DST via nextFpDocNumber. */
  noDokumen?: string;
  tanggal: string;
  kitchenId: string;
  kitchenNama?: string;
  sourceType: DistributionSourceType;
  productionPlanId?: string;
  productionPlanNo?: string;
  productionResultId?: string;
  productionResultNo?: string;
  lines: DistributionLine[];
  /** Jadwal lapangan: gelombang loading → armada → rute jam makan. */
  loadings?: DistributionLoading[];
  /** @deprecated legacy — dipakai bila loadings kosong (1 loading default). */
  armadas?: DistributionArmada[];
  status: DistributionStatus;
  history: DocHistoryEntry[];
  summary: {
    lineCount: number;
    qtyPorsiTotal: number;
    qtyDikirimTotal?: number;
    qtyDiterimaTotal?: number;
    qtyDikembalikanTotal?: number;
    servicePointCount: number;
    settledCount?: number;
    armadaCount?: number;
    loadingCount?: number;
  };
  catatan?: string;
  lastStatusPhotoUrls?: string[];
  /** W2-2: set when PROCESSING posted FG stock + FEFO. */
  stockPostedAt?: Date;
  /** W2-3: set when COMPLETED restocked returns. */
  stockReturnedAt?: Date;
  warehouseKode?: string;
  fefoConsume?: Array<{
    stokId: string;
    needQty: number;
    allocated: number;
    shortfall: number;
    skippedNoBatches: boolean;
    allocations?: unknown[];
  }>;
  fefoRestore?: Array<{
    stokId: string;
    needQty: number;
    restored: number;
    shortfall: number;
    allocations?: unknown[];
  }>;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

/**
 * Draft → Terjadwal → Dikirim → Selesai.
 * CANCELLED hanya untuk batalkan packing (Draft/Terjadwal), bukan retur per titik.
 */
export const DIST_STATUS_TRANSITIONS: Record<string, string[]> = {
  ...FP_DEFAULT_TRANSITIONS,
  DRAFT: ['APPROVED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'CANCELLED'],
  APPROVED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED'],
  COMPLETED: [],
};

export const DIST_STATUS_LABELS: Record<DistributionStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Draft',
  APPROVED: 'Terjadwal',
  PROCESSING: 'Dikirim',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};

export const DIST_UI_STATUS_NEXT: Partial<Record<DistributionStatus, DistributionStatus>> = {
  DRAFT: 'APPROVED',
  SUBMITTED: 'APPROVED',
  APPROVED: 'PROCESSING',
  PROCESSING: 'COMPLETED',
};

export const DIST_UI_STATUS_NEXT_LABEL: Partial<Record<DistributionStatus, string>> = {
  DRAFT: 'Jadwalkan',
  SUBMITTED: 'Jadwalkan',
  APPROVED: 'Dikirim',
  PROCESSING: 'Selesaikan titik',
};

export const DIST_STATUS_BADGE: Record<DistributionStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 border-slate-300',
  SUBMITTED: 'bg-slate-100 text-slate-700 border-slate-300',
  APPROVED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  PROCESSING: 'bg-amber-100 text-amber-800 border-amber-300',
  COMPLETED: 'bg-green-100 text-green-800 border-green-300',
  CANCELLED: 'bg-red-100 text-red-800 border-red-300',
};

export function hasDistDokumenNo(noDokumen?: string | null): boolean {
  return Boolean(String(noDokumen || '').trim());
}

export function distDocDisplayNo(doc: { noDokumen?: string | null }): string {
  const no = String(doc.noDokumen || '').trim();
  return no || 'Draft';
}

export function isDistEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

/** Packing hanya bisa diubah di Draft setelah HSL COMPLETED tersedia. */
export function distEditBlockedReason(input: {
  status: string;
  hasCompletedHsl: boolean;
}): string | null {
  if (!isDistEditable(input.status)) return 'Dokumen tidak dapat diubah';
  if (!input.hasCompletedHsl) {
    return 'Packing dapat diedit setelah HSL selesai';
  }
  return null;
}

/** Promosi Draft → Terjadwal (terbitkan nomor DST). */
export function canPromoteDistToScheduled(input: {
  status: string;
  hasCompletedHsl: boolean;
}): string | null {
  if (!(input.status === 'DRAFT' || input.status === 'SUBMITTED')) {
    return 'Hanya Draft yang dapat dijadwalkan';
  }
  if (!input.hasCompletedHsl) {
    return 'Jadwalkan setelah HSL selesai';
  }
  return null;
}

/** Titik sudah diselesaikan bila diterima+kembali menutup qty dikirim. */
export function isDistLineSettled(line: DistributionLine): boolean {
  if (line.qtyDiterima == null && line.qtyDikembalikan == null) return false;
  const sent = roundQty(Number(line.qtyDikirim ?? line.qtyPorsi) || 0);
  const recv = roundQty(Number(line.qtyDiterima) || 0);
  const ret = roundQty(Number(line.qtyDikembalikan) || 0);
  return Math.abs(roundQty(recv + ret) - sent) < 0.0001;
}

export function allDistLinesSettled(lines: DistributionLine[]): boolean {
  return (lines || []).length > 0 && (lines || []).every(isDistLineSettled);
}

export function summarizeDistLines(
  lines: DistributionLine[],
  opts?: { armadas?: DistributionArmada[]; loadings?: DistributionLoading[] },
) {
  const list = lines || [];
  const points = new Set(list.map((l) => l.servicePointId).filter(Boolean));
  const loadings = opts?.loadings?.length
    ? opts.loadings
    : (opts?.armadas?.length
      ? [{
        urutan: 1,
        label: 'Loading 1',
        jamStart: '00:00',
        jamMax: '00:00',
        armadas: opts.armadas,
        qtyPorsiTotal: roundQty(opts.armadas.reduce((s, a) => s + (Number(a.qtyPorsiTotal) || 0), 0)),
        servicePointCount: opts.armadas.reduce((s, a) => s + (Number(a.servicePointCount) || 0), 0),
      } satisfies DistributionLoading]
      : undefined);
  const armadaCount = loadings
    ? loadings.reduce((s, l) => s + (l.armadas || []).length, 0)
    : (opts?.armadas || []).length;
  return {
    lineCount: list.length,
    qtyPorsiTotal: roundQty(list.reduce((s, l) => s + (Number(l.qtyPorsi) || 0), 0)),
    qtyDikirimTotal: roundQty(list.reduce((s, l) => s + (Number(l.qtyDikirim) || 0), 0)),
    qtyDiterimaTotal: roundQty(list.reduce((s, l) => s + (Number(l.qtyDiterima) || 0), 0)),
    qtyDikembalikanTotal: roundQty(list.reduce((s, l) => s + (Number(l.qtyDikembalikan) || 0), 0)),
    servicePointCount: points.size,
    settledCount: list.filter(isDistLineSettled).length,
    armadaCount: armadaCount || undefined,
    loadingCount: loadings?.length || undefined,
  };
}

/** Kompatibel mundur: loadings, atau wrap armadas legacy jadi 1 loading. */
export function resolveDistLoadings(doc: {
  loadings?: DistributionLoading[] | null;
  armadas?: DistributionArmada[] | null;
}): DistributionLoading[] {
  if (doc.loadings?.length) return doc.loadings;
  if (doc.armadas?.length) {
    return [{
      urutan: 1,
      label: 'Loading 1',
      jamStart: '00:00',
      jamMax: '00:00',
      armadas: doc.armadas,
      qtyPorsiTotal: roundQty(doc.armadas.reduce((s, a) => s + (Number(a.qtyPorsiTotal) || 0), 0)),
      servicePointCount: doc.armadas.reduce((s, a) => s + (Number(a.servicePointCount) || 0), 0),
    }];
  }
  return [];
}

export function loadingLabel(urutan: number, label?: string): string {
  if (label?.trim()) return label.trim();
  const names = ['pertama', 'kedua', 'ketiga', 'keempat', 'kelima'];
  const n = names[urutan - 1];
  return n ? `Loading ${n}` : `Loading ${urutan}`;
}

/** Split qty/kategori proporsional ke jam pengiriman (by qtyHint atau equal). */
export function splitStopIntoDrops(input: {
  qtyPorsi: number;
  porsiByKategori?: ServicePointPorsiByKategori;
  drops: Array<{ dropId: string; jamKirim?: string; label?: string; qtyHint?: number }>;
}): DistributionStopDrop[] {
  const drops = input.drops || [];
  if (!drops.length) return [];
  const total = Math.round(Number(input.qtyPorsi) || 0);
  if (!(total > 0)) return [];
  const weights = drops.map((d) => {
    const h = Number(d.qtyHint);
    return Number.isFinite(h) && h > 0 ? h : 1;
  });
  const wSum = weights.reduce((s, w) => s + w, 0) || drops.length;
  const qtys: number[] = new Array(drops.length).fill(0);
  let allocated = 0;
  for (let i = 0; i < drops.length - 1; i++) {
    const q = Math.max(0, Math.round((total * weights[i]) / wSum));
    qtys[i] = q;
    allocated += q;
  }
  qtys[drops.length - 1] = Math.max(0, total - allocated);

  return drops.map((d, i) => ({
    dropId: d.dropId,
    jamKirim: d.jamKirim,
    label: d.label?.trim() || undefined,
    qtyPorsi: qtys[i],
    porsiByKategori: scalePorsiByKategoriForQty(
      input.porsiByKategori,
      qtys[i],
      total,
    ),
  })).filter((d) => d.qtyPorsi > 0);
}

/** Skala kategori porsi titik ke qty alokasi (berdasarkan kapasitas). */
export function scalePorsiByKategoriForQty(
  map: ServicePointPorsiByKategori | null | undefined,
  qtyPorsi: number,
  kapasitasPorsi?: number,
): ServicePointPorsiByKategori | undefined {
  if (!map) return undefined;
  const qty = Math.round(Number(qtyPorsi) || 0);
  if (!(qty > 0)) return undefined;
  const baseTotal = sumPorsiByKategori(map);
  if (!(baseTotal > 0)) return undefined;
  const kap = Number(kapasitasPorsi);
  const factor = Number.isFinite(kap) && kap > 0 ? qty / kap : qty / baseTotal;
  const keys = KATEGORI_PORSI_OPTIONS
    .map((o) => o.value)
    .filter((k) => (Number(map[k]) || 0) > 0) as KategoriPorsi[];
  if (!keys.length) return undefined;

  const out: ServicePointPorsiByKategori = {};
  let allocated = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const share = Math.max(0, Math.round((Number(map[key]) || 0) * factor));
    if (share > 0) {
      out[key] = share;
      allocated += share;
    }
  }
  const last = keys[keys.length - 1];
  const lastShare = Math.max(0, qty - allocated);
  if (lastShare > 0) out[last] = lastShare;
  return Object.keys(out).length ? out : undefined;
}

export function sumPorsiByKategoriMaps(
  maps: Array<ServicePointPorsiByKategori | null | undefined>,
): ServicePointPorsiByKategori {
  const out: ServicePointPorsiByKategori = {};
  for (const map of maps) {
    if (!map) continue;
    for (const opt of KATEGORI_PORSI_OPTIONS) {
      const n = Number(map[opt.value]) || 0;
      if (n > 0) out[opt.value] = (Number(out[opt.value]) || 0) + n;
    }
  }
  return out;
}

export type DistLoadingArmadaInput = {
  armadaId: string;
  armadaKode?: string;
  armadaNama?: string;
  platNomor?: string;
  kapasitasPorsi?: number;
  servicePointIds: string[];
  /** Opsional: override jam pengiriman per titik. */
  stopDrops?: Record<string, Array<{
    dropId: string;
    jamKirim?: string;
    label?: string;
    qtyHint?: number;
    qtyPorsi?: number;
  }>>;
};

export type DistLoadingInput = {
  urutan?: number;
  label?: string;
  jamStart: string;
  jamMax: string;
  armadas: DistLoadingArmadaInput[];
};

/**
 * Bangun gelombang loading + armada + rute jam makan.
 * Setiap titik alokasi harus masuk tepat satu armada (lintas loading).
 */
export function buildDistributionLoadings(input: {
  loadings: DistLoadingInput[];
  lines: DistributionLine[];
  /** Master jam pengiriman per servicePointId (fallback bila stopDrops tidak dikirim). */
  dropsByServicePointId?: Record<string, Array<{
    dropId: string;
    jamKirim?: string;
    label?: string;
    qtyHint?: number;
    qtyPorsi?: number;
  }>>;
}): { loadings: DistributionLoading[]; armadas: DistributionArmada[]; lines: DistributionLine[] } | { error: string } {
  const rawLoadings = input.loadings || [];
  if (!rawLoadings.length) return { error: 'Minimal satu gelombang loading wajib' };

  const qtyBySp = new Map<string, number>();
  const metaBySp = new Map<string, DistributionLine>();
  for (const line of input.lines || []) {
    const id = String(line.servicePointId || '').trim();
    if (!id) continue;
    qtyBySp.set(id, roundQty((qtyBySp.get(id) || 0) + (Number(line.qtyPorsi) || 0)));
    if (!metaBySp.has(id)) metaBySp.set(id, line);
  }
  const allSpIds = [...qtyBySp.keys()];
  if (!allSpIds.length) return { error: 'Tidak ada titik untuk dirute' };

  const claimed = new Map<string, string>();
  const loadings: DistributionLoading[] = [];
  const flatArmadas: DistributionArmada[] = [];

  for (let li = 0; li < rawLoadings.length; li++) {
    const L = rawLoadings[li];
    const urutan = Number(L.urutan) > 0 ? Math.round(Number(L.urutan)) : li + 1;
    const jamStart = normalizeJamKirim(L.jamStart);
    if (jamStart && typeof jamStart === 'object' && 'error' in jamStart) {
      return { error: `Loading ${urutan}: ${jamStart.error}` };
    }
    const jamMax = normalizeJamKirim(L.jamMax);
    if (jamMax && typeof jamMax === 'object' && 'error' in jamMax) {
      return { error: `Loading ${urutan}: ${jamMax.error}` };
    }
    if (!jamStart || !jamMax) {
      return { error: `Loading ${urutan}: jamStart dan jamMax wajib` };
    }
    if (compareJamKirim(jamStart, jamMax) > 0) {
      return { error: `Loading ${urutan}: jamStart tidak boleh setelah jamMax` };
    }
    if (!L.armadas?.length) {
      return { error: `Loading ${urutan}: minimal satu armada` };
    }

    const armadas: DistributionArmada[] = [];
    for (const asg of L.armadas) {
      const armadaId = String(asg.armadaId || '').trim();
      if (!armadaId) return { error: `Loading ${urutan}: armadaId wajib` };
      const ids = [...new Set((asg.servicePointIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
      if (!ids.length) {
        return { error: `Armada ${asg.armadaNama || asg.armadaKode || armadaId}: pilih minimal satu titik` };
      }

      for (const spId of ids) {
        if (!qtyBySp.has(spId)) {
          return { error: `Titik ${spId} tidak ada di alokasi packing` };
        }
        if (claimed.has(spId)) {
          return { error: 'Titik tidak boleh masuk lebih dari satu armada / loading' };
        }
        claimed.set(spId, armadaId);
      }

      const stopsRaw = ids.map((spId) => {
        const meta = metaBySp.get(spId)!;
        const qtyPorsi = qtyBySp.get(spId) || 0;
        const porsiByKategori = meta.porsiByKategori;
        const dropSrc = asg.stopDrops?.[spId]
          || input.dropsByServicePointId?.[spId]
          || [];
        const drops = dropSrc.length
          ? (() => {
            const withExplicit = dropSrc.every((d) => Number(d.qtyPorsi) > 0);
            const built = withExplicit
              ? dropSrc.map((d) => ({
                dropId: d.dropId,
                label: d.label,
                jamKirim: d.jamKirim,
                qtyPorsi: Math.round(Number(d.qtyPorsi) || 0),
                porsiByKategori: scalePorsiByKategoriForQty(
                  porsiByKategori,
                  Math.round(Number(d.qtyPorsi) || 0),
                  qtyPorsi,
                ),
              })).filter((d) => d.qtyPorsi > 0)
              : splitStopIntoDrops({
                qtyPorsi,
                porsiByKategori,
                drops: dropSrc.map((d) => ({
                  dropId: d.dropId,
                  label: d.label,
                  jamKirim: d.jamKirim,
                  qtyHint: d.qtyHint,
                })),
              });
            return [...built].sort((a, b) => compareJamKirim(a.jamKirim, b.jamKirim));
          })()
          : undefined;
        const jamKirim = routeJamKirim({ jamKirim: meta.jamKirim, drops });
        return {
          servicePointId: spId,
          servicePointKode: meta.servicePointKode,
          servicePointNama: meta.servicePointNama,
          jamKirim,
          kapasitasPorsi: meta.kapasitasPorsi,
          qtyPorsi,
          porsiByKategori,
          drops,
        };
      }).sort((a, b) => {
        const byJam = compareJamKirim(a.jamKirim, b.jamKirim);
        if (byJam !== 0) return byJam;
        return String(a.servicePointNama || a.servicePointId)
          .localeCompare(String(b.servicePointNama || b.servicePointId), 'id');
      });

      const stops: DistributionArmadaStop[] = stopsRaw.map((s, idx) => ({
        urutan: idx + 1,
        ...s,
      }));
      const porsiByKategori = sumPorsiByKategoriMaps(stops.map((s) => s.porsiByKategori));
      const qtyPorsiTotal = roundQty(stops.reduce((s, x) => s + (Number(x.qtyPorsi) || 0), 0));
      const armada: DistributionArmada = {
        armadaId,
        armadaKode: asg.armadaKode,
        armadaNama: asg.armadaNama,
        platNomor: asg.platNomor,
        kapasitasPorsi: asg.kapasitasPorsi,
        stops,
        porsiByKategori,
        qtyPorsiTotal,
        servicePointCount: stops.length,
      };
      armadas.push(armada);
      flatArmadas.push(armada);
    }

    loadings.push({
      urutan,
      label: L.label?.trim() || loadingLabel(urutan),
      jamStart,
      jamMax,
      armadas,
      qtyPorsiTotal: roundQty(armadas.reduce((s, a) => s + a.qtyPorsiTotal, 0)),
      servicePointCount: armadas.reduce((s, a) => s + a.servicePointCount, 0),
    });
  }

  for (const spId of allSpIds) {
    if (!claimed.has(spId)) {
      const meta = metaBySp.get(spId);
      const label = meta?.servicePointNama || meta?.servicePointKode || spId;
      return { error: `Titik "${label}" belum di-assign ke armada` };
    }
  }

  const lines = (input.lines || []).map((l) => ({
    ...l,
    armadaId: claimed.get(l.servicePointId),
  }));

  return { loadings, armadas: flatArmadas, lines };
}

/** Legacy helper — wrap ke satu loading default. */
export function buildDistributionArmadas(input: {
  assignments: DistLoadingArmadaInput[];
  lines: DistributionLine[];
}): { armadas: DistributionArmada[]; lines: DistributionLine[] } | { error: string } {
  const built = buildDistributionLoadings({
    loadings: [{
      urutan: 1,
      label: 'Loading 1',
      jamStart: '00:00',
      jamMax: '00:00',
      armadas: input.assignments,
    }],
    lines: input.lines,
  });
  if ('error' in built) return built;
  return { armadas: built.armadas, lines: built.lines };
}

/** Porsi lapangan = bilangan bulat (bukan KG pecahan). */
function optionalNonNegQty(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n);
}

export function normalizeDistLines(raw: unknown): DistributionLine[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Minimal satu baris distribusi' };
  const out: DistributionLine[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const servicePointId = String(row.servicePointId || '').trim();
    const qtyPorsi = Number(row.qtyPorsi);
    if (!servicePointId) return { error: `Baris ${i + 1}: servicePointId wajib` };
    if (!Number.isFinite(qtyPorsi) || qtyPorsi <= 0) {
      return { error: `Baris ${i + 1}: qtyPorsi harus > 0` };
    }
    const menuId = row.menuId != null ? String(row.menuId).trim() || undefined : undefined;
    const recipeId = row.recipeId != null ? String(row.recipeId).trim() || undefined : undefined;
    const fgId = row.finishedGoodProductId != null
      ? String(row.finishedGoodProductId).trim() || undefined
      : undefined;
    const itemKey = distLineKey({ menuId, finishedGoodProductId: fgId, recipeId });
    if (itemKey === '|') {
      return { error: `Baris ${i + 1}: wajib menuId, finishedGoodProductId, atau recipeId` };
    }
    const key = `${servicePointId}|${itemKey}`;
    if (seen.has(key)) return { error: `Baris ${i + 1}: duplikat titik × menu/FG/resep` };
    seen.add(key);
    const kapasitas = optionalNonNegQty(row.kapasitasPorsi);
    const qtyDikirim = optionalNonNegQty(row.qtyDikirim);
    const qtyDiterima = optionalNonNegQty(row.qtyDiterima);
    const qtyDikembalikan = optionalNonNegQty(row.qtyDikembalikan);
    const jamKirim = row.jamKirim != null ? String(row.jamKirim).trim() || undefined : undefined;
    const armadaId = row.armadaId != null ? String(row.armadaId).trim() || undefined : undefined;
    const porsiByKategori = row.porsiByKategori && typeof row.porsiByKategori === 'object'
      ? (row.porsiByKategori as ServicePointPorsiByKategori)
      : undefined;
    out.push({
      servicePointId,
      servicePointKode: row.servicePointKode != null ? String(row.servicePointKode) : undefined,
      servicePointNama: row.servicePointNama != null ? String(row.servicePointNama) : undefined,
      kapasitasPorsi: kapasitas,
      jamKirim,
      porsiByKategori,
      armadaId,
      menuId,
      menuKode: row.menuKode != null ? String(row.menuKode) : undefined,
      menuNama: row.menuNama != null ? String(row.menuNama) : undefined,
      recipeId,
      recipeKode: row.recipeKode != null ? String(row.recipeKode) : undefined,
      recipeNama: row.recipeNama != null ? String(row.recipeNama) : undefined,
      finishedGoodProductId: fgId,
      finishedGoodKode: row.finishedGoodKode != null ? String(row.finishedGoodKode) : undefined,
      finishedGoodNama: row.finishedGoodNama != null ? String(row.finishedGoodNama) : undefined,
      qtyPorsi: Math.round(qtyPorsi),
      ...(qtyDikirim != null ? { qtyDikirim } : {}),
      ...(qtyDiterima != null ? { qtyDiterima } : {}),
      ...(qtyDikembalikan != null ? { qtyDikembalikan } : {}),
      notes: row.notes != null ? String(row.notes) : undefined,
    });
  }
  return out;
}

/** Apply qty dikirim per line (status → Dikirim). */
export function applyDistLineActuals(
  lines: DistributionLine[],
  toStatus: string,
  actuals?: Array<{
    servicePointId: string;
    menuId?: string;
    recipeId?: string;
    finishedGoodProductId?: string;
    qty: number;
    notes?: string;
  }>,
): DistributionLine[] | { error: string } {
  if (toStatus === 'COMPLETED') {
    return { error: 'Gunakan settle per titik (diterima + dikembalikan) untuk menyelesaikan distribusi' };
  }
  const byKey = new Map<string, { qty: number; notes?: string }>();
  for (const a of actuals || []) {
    const sp = String(a.servicePointId || '').trim();
    if (!sp) continue;
    const qty = Number(a.qty);
    if (!Number.isFinite(qty) || qty < 0) {
      return { error: 'Qty actual per titik harus ≥ 0' };
    }
    const notes = a.notes != null ? String(a.notes).trim() : undefined;
    byKey.set(`${sp}|${distLineKey(a)}`, {
      qty: roundQty(qty),
      notes: a.notes != null ? (notes || '') : undefined,
    });
  }

  return lines.map((line) => {
    const key = `${line.servicePointId}|${distLineKey(line)}`;
    const actual = byKey.get(key);
    const next = { ...line };
    if (toStatus === 'PROCESSING') {
      next.qtyDikirim = actual ? actual.qty : (line.qtyDikirim ?? line.qtyPorsi);
      if (actual?.notes !== undefined) next.notes = actual.notes.trim() || undefined;
    }
    return next;
  });
}

/**
 * Selesaikan per titik: isi qtyDiterima + qtyDikembalikan (jumlah harus = qtyDikirim).
 */
export function applyDistSettleLines(
  lines: DistributionLine[],
  settles?: Array<{
    servicePointId: string;
    menuId?: string;
    recipeId?: string;
    finishedGoodProductId?: string;
    qtyDiterima: number;
    qtyDikembalikan: number;
    notes?: string;
  }>,
): DistributionLine[] | { error: string } {
  const byKey = new Map<string, {
    qtyDiterima: number;
    qtyDikembalikan: number;
    notes?: string;
  }>();
  for (const a of settles || []) {
    const sp = String(a.servicePointId || '').trim();
    if (!sp) continue;
    const qtyDiterima = Number(a.qtyDiterima);
    const qtyDikembalikan = Number(a.qtyDikembalikan);
    if (!Number.isFinite(qtyDiterima) || qtyDiterima < 0) {
      return { error: 'Qty diterima per titik harus ≥ 0' };
    }
    if (!Number.isFinite(qtyDikembalikan) || qtyDikembalikan < 0) {
      return { error: 'Qty dikembalikan per titik harus ≥ 0' };
    }
    const notes = a.notes != null ? String(a.notes).trim() : undefined;
    byKey.set(`${sp}|${distLineKey(a)}`, {
      qtyDiterima: roundQty(qtyDiterima),
      qtyDikembalikan: roundQty(qtyDikembalikan),
      notes: a.notes != null ? (notes || '') : undefined,
    });
  }

  const out: DistributionLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = `${line.servicePointId}|${distLineKey(line)}`;
    const settle = byKey.get(key);
    const next = { ...line };
    if (next.qtyDikirim == null) next.qtyDikirim = line.qtyPorsi;
    const sent = roundQty(Number(next.qtyDikirim) || 0);

    if (settle) {
      next.qtyDiterima = settle.qtyDiterima;
      next.qtyDikembalikan = settle.qtyDikembalikan;
      if (settle.notes !== undefined) next.notes = settle.notes.trim() || undefined;
    } else if (next.qtyDiterima == null && next.qtyDikembalikan == null) {
      // default: semua diterima, tidak ada retur
      next.qtyDiterima = sent;
      next.qtyDikembalikan = 0;
    }

    const recv = roundQty(Number(next.qtyDiterima) || 0);
    const ret = roundQty(Number(next.qtyDikembalikan) || 0);
    if (Math.abs(roundQty(recv + ret) - sent) > 0.0001) {
      const nama = line.servicePointNama || line.servicePointKode || line.servicePointId;
      return {
        error: `Titik "${nama}": diterima (${recv}) + dikembalikan (${ret}) harus = dikirim (${sent})`,
      };
    }
    out.push(next);
  }
  return out;
}

/** Movement qty for a status step (sum of relevant actual field). */
export function movementQtyForStatus(lines: DistributionLine[], toStatus: string): number {
  if (toStatus === 'PROCESSING') {
    return roundQty(lines.reduce((s, l) => s + (Number(l.qtyDikirim ?? l.qtyPorsi) || 0), 0));
  }
  if (toStatus === 'COMPLETED') {
    return roundQty(lines.reduce((s, l) => s + (Number(l.qtyDiterima) || 0) + (Number(l.qtyDikembalikan) || 0), 0));
  }
  return roundQty(lines.reduce((s, l) => s + (Number(l.qtyPorsi) || 0), 0));
}

/**
 * Gabung baris resep/menu → 1 item Food Tray.
 * Qty = max porsi baris (1 tray = 1 set makanan, bukan penjumlahan tiap resep).
 */
export function collapseSourceToFoodTray(
  items: Array<{ qtyPorsi: number }>,
): Array<{
  recipeId: string;
  recipeNama: string;
  menuNama: string;
  finishedGoodNama: string;
  qtyPorsi: number;
}> | { error: string } {
  const qtys = (items || []).map((i) => Number(i.qtyPorsi) || 0).filter((q) => q > 0);
  if (!qtys.length) return { error: 'Sumber alokasi tidak ditemukan' };
  return [{
    recipeId: FOOD_TRAY_ID,
    recipeNama: FOOD_TRAY_LABEL,
    menuNama: FOOD_TRAY_LABEL,
    finishedGoodNama: FOOD_TRAY_LABEL,
    qtyPorsi: roundQty(Math.max(...qtys)),
  }];
}

/** Build draft packing lines: each plan/result line × each service point (equal split). */
export function allocatePorsiAcrossPoints(input: {
  items: Array<{
    menuId?: string;
    menuKode?: string;
    menuNama?: string;
    recipeId?: string;
    recipeKode?: string;
    recipeNama?: string;
    finishedGoodProductId?: string;
    finishedGoodKode?: string;
    finishedGoodNama?: string;
    qtyPorsi: number;
  }>;
  servicePoints: Array<{
    id: string;
    kode?: string;
    nama: string;
    kapasitasPorsi?: number;
    jamKirim?: string;
    drops?: Array<{ jamKirim?: string }>;
    porsiByKategori?: ServicePointPorsiByKategori;
  }>;
}): DistributionLine[] | { error: string } {
  if (!input.items.length) return { error: 'Tidak ada menu/hasil untuk dialokasikan' };
  if (!input.servicePoints.length) return { error: 'Pilih minimal satu titik layanan' };

  const points = input.servicePoints;
  const out: DistributionLine[] = [];

  for (const item of input.items) {
    const total = Math.round(Number(item.qtyPorsi) || 0);
    if (!(total > 0)) continue;
    // Weighted by kapasitas when set; else equal split.
    // Integer shares; non-negative; sum exactly to total (remainder on last point).
    const weights = points.map((p) => {
      const k = Number(p.kapasitasPorsi);
      return Number.isFinite(k) && k > 0 ? k : 1;
    });
    const weightSum = weights.reduce((s, w) => s + w, 0) || points.length;
    const shares: number[] = new Array(points.length).fill(0);
    let allocated = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const share = Math.max(0, Math.round((total * weights[i]) / weightSum));
      shares[i] = share;
      allocated += share;
    }
    shares[points.length - 1] = Math.max(0, total - allocated);
    // If early rounding overshot, peel from earlier points so last stays ≥ 0 and sum = total.
    let sum = shares.reduce((s, n) => s + n, 0);
    let drift = total - sum;
    if (drift !== 0) {
      for (let i = points.length - 1; i >= 0 && drift !== 0; i--) {
        const next = shares[i] + drift;
        if (next >= 0) {
          shares[i] = next;
          drift = 0;
        } else {
          drift += shares[i];
          shares[i] = 0;
        }
      }
    }
    for (let i = 0; i < points.length; i++) {
      const share = shares[i];
      if (!(share > 0)) continue;
      const sp = points[i];
      const kapasitasPorsi = Number.isFinite(Number(sp.kapasitasPorsi)) && Number(sp.kapasitasPorsi) > 0
        ? Number(sp.kapasitasPorsi)
        : undefined;
      out.push({
        servicePointId: sp.id,
        servicePointKode: sp.kode,
        servicePointNama: sp.nama,
        kapasitasPorsi,
        jamKirim: routeJamKirim({ jamKirim: sp.jamKirim, drops: sp.drops }),
        porsiByKategori: scalePorsiByKategoriForQty(sp.porsiByKategori, share, kapasitasPorsi),
        menuId: item.menuId,
        menuKode: item.menuKode,
        menuNama: item.menuNama || item.recipeNama || item.finishedGoodNama,
        recipeId: item.recipeId,
        recipeKode: item.recipeKode,
        recipeNama: item.recipeNama,
        finishedGoodProductId: item.finishedGoodProductId,
        finishedGoodKode: item.finishedGoodKode,
        finishedGoodNama: item.finishedGoodNama,
        qtyPorsi: share,
      });
    }
  }

  if (!out.length) return { error: 'Alokasi menghasilkan 0 baris' };
  return out;
}

/** Source items minus already-consumed non-CANCELLED DST (same source keys). */
export function remainingSourceItems(
  sourceItems: Array<{
    menuId?: string;
    menuKode?: string;
    menuNama?: string;
    recipeId?: string;
    recipeKode?: string;
    recipeNama?: string;
    finishedGoodProductId?: string;
    finishedGoodKode?: string;
    finishedGoodNama?: string;
    qtyPorsi: number;
  }>,
  existingConsumedLines?: DistributionLine[],
): Array<{
  menuId?: string;
  menuKode?: string;
  menuNama?: string;
  recipeId?: string;
  recipeKode?: string;
  recipeNama?: string;
  finishedGoodProductId?: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  qtyPorsi: number;
}> | { error: string } {
  if (!sourceItems.length) return { error: 'Sumber alokasi tidak ditemukan' };
  const used = new Map<string, number>();
  for (const l of existingConsumedLines || []) {
    const key = distLineKey(l);
    used.set(key, roundQty((used.get(key) || 0) + (Number(l.qtyPorsi) || 0)));
  }
  const out: typeof sourceItems = [];
  for (const src of sourceItems) {
    const key = distLineKey(src);
    if (key === '|') {
      return { error: 'Baris sumber tidak punya menuId/finishedGoodProductId/recipeId' };
    }
    const remain = roundQty((Number(src.qtyPorsi) || 0) - (used.get(key) || 0));
    if (remain > 0) {
      out.push({ ...src, qtyPorsi: remain });
      used.delete(key);
    } else {
      used.delete(key);
    }
  }
  // Orphan consumed keys (different source type) are ignored here — assertDistQtyWithinSource
  // still guards on the final lines against the original source.
  if (!out.length) return { error: 'Sumber sudah teralokasi penuh' };
  return out;
}

/**
 * Identitas item alokasi.
 * Prefer menu|FG (legacy); fallback recipe:… untuk MBG resep-langsung tanpa menu/FG.
 */
export function distLineKey(line: {
  menuId?: string;
  finishedGoodProductId?: string;
  recipeId?: string;
}): string {
  const menuId = String(line.menuId || '').trim();
  const fgId = String(line.finishedGoodProductId || '').trim();
  const recipeId = String(line.recipeId || '').trim();
  if (menuId || fgId) return `${menuId}|${fgId}`;
  if (recipeId) return `recipe:${recipeId}`;
  return '|';
}

/** Remaining porsi vs source — includes non-cancelled DST already consumed. */
export function assertDistQtyWithinSource(input: {
  sourceItems: Array<{
    menuId?: string;
    finishedGoodProductId?: string;
    recipeId?: string;
    qtyPorsi: number;
  }>;
  newLines: DistributionLine[];
  /** Non-CANCELLED lines already allocated (open + completed). */
  existingConsumedLines?: DistributionLine[];
}): string | null {
  if (!input.sourceItems.length) {
    return 'Sumber alokasi tidak ditemukan';
  }
  const availByKey = new Map<string, number>();
  for (const src of input.sourceItems) {
    const key = distLineKey(src);
    if (key === '|') return 'Baris sumber tidak punya menuId/finishedGoodProductId/recipeId';
    availByKey.set(key, roundQty((availByKey.get(key) || 0) + (Number(src.qtyPorsi) || 0)));
  }

  const used = new Map<string, number>();
  const bump = (lines: DistributionLine[]) => {
    for (const l of lines) {
      const key = distLineKey(l);
      used.set(key, roundQty((used.get(key) || 0) + (Number(l.qtyPorsi) || 0)));
    }
  };
  bump(input.existingConsumedLines || []);
  bump(input.newLines);

  for (const [key, take] of used) {
    if (!availByKey.has(key)) {
      return `Baris alokasi tidak ada di sumber (${key || 'kosong'})`;
    }
    const avail = availByKey.get(key) || 0;
    if (take > avail + 0.0001) {
      return `Alokasi melebihi sumber untuk ${key}: ${take} > ${avail}`;
    }
  }
  return null;
}
