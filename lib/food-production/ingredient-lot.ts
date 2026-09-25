/**
 * W2-5 — Ingredient lots stamped on GRN POST (foundation for W2-6 Issue FEFO).
 */

import { roundStockQty } from '@/lib/stock-ledger/precision';

export const INGREDIENT_LOTS_COLLECTION = 'ingredient_lots';

/**
 * Hanya jalur lama (flag `lotExpiryRequired` mati): lot tanpa kedaluwarsa diberi +30 hari dan
 * ditandai `expirySource: 'DEFAULT'` agar terlihat di laporan — bukan default diam-diam.
 */
export const LEGACY_DEFAULT_SHELF_DAYS = 30;
export const MAX_SHELF_LIFE_DAYS = 3650;

/** INPUT = diisi saat terima; MASTER_SHELF = tanggal terima + masa simpan master; DEFAULT = jalur lama. */
export type LotExpirySource = 'INPUT' | 'MASTER_SHELF' | 'DEFAULT';

export type IngredientLotStatus = 'ACTIVE' | 'EXPIRED' | 'CONSUMED';

export type IngredientLotSourceType = 'GRN' | 'PENYESUAIAN';

/**
 * Fase 3.2 — status QC lot. Kosong = RELEASED (lot lama / flag `lotQcRequired` mati).
 * QUARANTINE & REJECTED tetap stok fisik di gudang, tetapi tidak boleh keluar (FEFO/transfer/RL).
 */
export type LotQcStatus = 'QUARANTINE' | 'RELEASED' | 'REJECTED';
export const LOT_QC_HELD_STATUSES: readonly LotQcStatus[] = ['QUARANTINE', 'REJECTED'];

/** Tindak lanjut lot REJECTED: menunggu → draft RTV dibuat → (RTV diposting = lot habis) / dimusnahkan. */
export type LotQcRejectStatus = 'PENDING' | 'RTV_CREATED' | 'DISPOSED';

export function effectiveLotQcStatus(lot: { qcStatus?: string | null }): LotQcStatus {
  return lot.qcStatus === 'QUARANTINE' || lot.qcStatus === 'REJECTED' ? lot.qcStatus : 'RELEASED';
}

export function isLotQcHeld(lot: { qcStatus?: string | null }): boolean {
  return effectiveLotQcStatus(lot) !== 'RELEASED';
}

/** Filter Mongo: hanya lot yang boleh keluar (RELEASED atau tanpa status QC). */
export const LOT_QC_RELEASED_FILTER = { qcStatus: { $nin: [...LOT_QC_HELD_STATUSES] } } as const;

export const LOT_QC_STATUS_LABEL: Record<LotQcStatus, string> = {
  QUARANTINE: 'Karantina QC',
  RELEASED: 'Lolos QC',
  REJECTED: 'Ditolak QC',
};

export interface IngredientLotDoc {
  id: string;
  tenantId: string;
  lotNo: string;
  /** Kosong untuk lot dari penyesuaian stok (bukan GRN). */
  grnId?: string;
  noGRN?: string;
  /** Asal lot: GRN (default/legacy) atau PENYESUAIAN. */
  sourceType?: IngredientLotSourceType;
  penyesuaianId?: string;
  noPenyesuaian?: string;
  productId: string;
  productKode?: string;
  productNama?: string;
  warehouseKode: string;
  /** W2-16: optional bin address (does not change warehouse FEFO grain). */
  binKode?: string;
  receivedAt: string;
  expiryDate: string;
  /** Kosong pada lot lama (sebelum Fase 3.1). */
  expirySource?: LotExpirySource;
  /** Nomor lot/batch dari pemasok (label kemasan). */
  supplierLotNo?: string;
  qty: number;
  qtyRemaining: number;
  satuan?: string;
  /** ADR-004 Fase 6 — denormalisasi dari GRN (vendorTenantId / supplierId). Nama dari master. */
  supplierId?: string;
  status: IngredientLotStatus;
  /** Fase 3.2 — kosong = RELEASED. */
  qcStatus?: LotQcStatus;
  /** Penerima GRN (userId) — pemeriksa QC tidak boleh orang yang sama (kecuali ADMIN/MASTER). */
  receivedByUserId?: string;
  qcInspectionId?: string;
  noInspeksi?: string;
  qcInspectedAt?: Date;
  /** Lot REJECTED hasil pecahan inspeksi sebagian — menunjuk lot asal. */
  qcSplitFromLotId?: string;
  qcRejectStatus?: LotQcRejectStatus;
  qcRejectReason?: string;
  qcRejectRtvId?: string;
  qcRejectNoReturn?: string;
  qcDisposal?: { noDokumen: string; reason: string; at: Date };
  lineIndex?: number;
  lastConsumedBy?: {
    issueId?: string;
    noDokumen?: string;
    at?: Date;
  };
  lastCycleCountBy?: {
    noDokumen?: string;
    delta?: number;
    at?: Date;
  };
  /** W2-13: set when lot cloned on partial transfer relocate. */
  relocatedFromLotId?: string;
  /** W2-13: last TR/XFR that relocated this lot (or its remainder). */
  lastRelocatedBy?: {
    transferId?: string;
    xferId?: string;
    noTransaksi?: string;
    fromWarehouseKode?: string;
    toWarehouseKode?: string;
    at?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

export function buildIngredientLotNo(input: {
  noGRN?: string;
  productKode?: string;
  lineIndex: number;
  receivedAt: string;
}): string {
  const day = String(input.receivedAt || '').replace(/-/g, '').slice(0, 8) || '00000000';
  const grn = String(input.noGRN || 'GRN').split('-').pop() || 'X';
  const kode = String(input.productKode || 'P').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'P';
  return `L-${grn}-${kode}-${day}-${input.lineIndex + 1}`.toUpperCase();
}

/** Lot nomor untuk stok masuk via penyesuaian (tanpa GRN). */
export function buildPenyesuaianLotNo(input: {
  noPenyesuaian?: string;
  productKode?: string;
  receivedAt: string;
}): string {
  const day = String(input.receivedAt || '').replace(/-/g, '').slice(0, 8) || '00000000';
  const ps = String(input.noPenyesuaian || 'PS').replace(/[^A-Za-z0-9]/g, '').slice(-10) || 'PS';
  const kode = String(input.productKode || 'P').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'P';
  return `L-${ps}-${kode}-${day}`.toUpperCase();
}

/** Zona waktu operasional (WIB). Tanggal terima & batas kedaluwarsa dihitung per hari WIB, bukan UTC. */
export const BUSINESS_UTC_OFFSET_HOURS = 7;

/** Tanggal kalender WIB (YYYY-MM-DD) dari sebuah instan. */
export function businessDateIso(at: Date = new Date()): string {
  return new Date(at.getTime() + BUSINESS_UTC_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);
}

/** Tanggal terima (YYYY-MM-DD) + n hari. */
export function addShelfDays(receivedAt: string | Date, shelfDays: number): string {
  const raw = typeof receivedAt === 'string'
    ? receivedAt.trim()
    : businessDateIso(receivedAt);
  const base = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00.000Z`)
    : new Date();
  base.setUTCDate(base.getUTCDate() + Math.max(0, shelfDays));
  return base.toISOString().slice(0, 10);
}

/**
 * YYYY-MM-DD (atau ISO datetime utuh; bagian tanggal yang dipakai) yang benar-benar ada di kalender (2026-02-30 ditolak);
 * sisa teks sembarang setelah tanggal ditolak. Selain itu null.
 */
export function parseIsoDateOnly(raw: unknown): string | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  const full = String(raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(full)) return null;
  const s = full.slice(0, 10);
  const d = new Date(`${s}T12:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/** Masa simpan master: bilangan bulat 1–3650 hari, atau null (tidak diisi). */
export function normalizeShelfLifeDays(raw: unknown): number | null | { error: string } {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SHELF_LIFE_DAYS) {
    return { error: `Masa simpan harus bilangan bulat 1–${MAX_SHELF_LIFE_DAYS} hari` };
  }
  return n;
}

export type LotExpiryInput = {
  receivedAt: string;
  /** Tanggal kedaluwarsa dari form terima / baris GRN. */
  inputExpiry?: unknown;
  /** products.shelfLifeDays item persediaan. */
  shelfLifeDays?: unknown;
  /** Flag `lotExpiryRequired`. */
  required: boolean;
  label: string;
};

export type LotExpiryResult = { expiryDate: string; expirySource: LotExpirySource } | { error: string };

/**
 * Kedaluwarsa lot baru: isian → masa simpan master → (wajib: tolak | jalur lama: +30, DEFAULT).
 * Isian selalu divalidasi ketat (flag aktif atau tidak): tanggal nyata, tidak sebelum tanggal terima,
 * ≤ 10 tahun — isian rusak tidak boleh jatuh diam-diam ke default.
 */
export function resolveLotExpiry(input: LotExpiryInput): LotExpiryResult {
  const hasInput = String(input.inputExpiry ?? '').trim() !== '';
  const parsed = parseIsoDateOnly(input.inputExpiry);
  if (hasInput) {
    if (!parsed) return { error: `Tanggal kedaluwarsa ${input.label} tidak valid (format YYYY-MM-DD)` };
    if (parsed < input.receivedAt) {
      return { error: `${input.label} sudah kedaluwarsa (${parsed}) saat diterima ${input.receivedAt} — tolak barangnya` };
    }
    if (parsed > addShelfDays(input.receivedAt, MAX_SHELF_LIFE_DAYS)) {
      return { error: `Tanggal kedaluwarsa ${input.label} lebih dari 10 tahun — periksa isian` };
    }
  }
  if (parsed) return { expiryDate: parsed, expirySource: 'INPUT' };
  const shelf = normalizeShelfLifeDays(input.shelfLifeDays);
  if (typeof shelf === 'number') {
    return { expiryDate: addShelfDays(input.receivedAt, shelf), expirySource: 'MASTER_SHELF' };
  }
  if (input.required) {
    return { error: `Tanggal kedaluwarsa wajib untuk ${input.label} (atau isi masa simpan di master produk)` };
  }
  return { expiryDate: addShelfDays(input.receivedAt, LEGACY_DEFAULT_SHELF_DAYS), expirySource: 'DEFAULT' };
}

export function effectiveIngredientQtyRemaining(
  b: Pick<IngredientLotDoc, 'qty' | 'status'> & { qtyRemaining?: number | null },
): number {
  if (b.qtyRemaining != null && Number.isFinite(Number(b.qtyRemaining))) {
    return Math.max(0, roundStockQty(b.qtyRemaining));
  }
  if (b.status === 'CONSUMED') return 0;
  const q = roundStockQty(b.qty);
  return q > 0 ? q : 0;
}

export function isIngredientExpired(expiryDate: string, asOf = new Date()): boolean {
  const exp = String(expiryDate || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return false;
  return exp < businessDateIso(asOf);
}
