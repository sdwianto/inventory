// Biaya rata-rata bergerak per produk per tenant (Fase 4). Aturan murni: dipakai buku stok saat posting
// dan migrasi backfill agar hasil replay sama persis dengan posting langsung.
//
// - Masuk berbiaya (GRN, stok awal, retur vendor ditolak, lainnya dengan harga baris > 0) mengubah rata-rata.
//   Baris GRN berharga Rp0 (bonus) masuk pada Rp0 sehingga nilai kartu = nilai akrual GRN.
// - Masuk netral (pindah gudang, hitung fisik, retur distribusi) dinilai pada rata-rata; rata-rata tetap.
// - Keluar dinilai pada rata-rata, kecuali pembalik pembelian (pembalik GRN, retur vendor) yang keluar
//   pada harga belinya sendiri dan menghitung ulang rata-rata sisa stok.
// - Barang jadi / setengah jadi dan semua mutasi hasil produksi / distribusi = memo qty tanpa nilai
//   (biaya bahan dibebankan saat RL / PBL).

import { STOCK_QTY_EPS, roundStockQty, roundUnitCost } from '@/lib/stock-ledger/precision';

export type StockCostSource = 'LINE' | 'PRODUCT_AVG' | 'AVG' | 'NON_INVENTORY' | 'NONE';

const AVG_NEUTRAL_INBOUND = new Set([
  'TRANSFER',
  'FP_XFER',
  'RELOKASI_GUDANG',
  'PENYESUAIAN',
  'FP_ADJUST',
  'FP_DIST_RETURN',
]);

// STOCK_REVERSAL keluar pada harga kartu asli; masuknya (harga baris > 0) mencampur rata-rata pada harga itu,
// sehingga pasangan posting + pembalik mengembalikan rata-rata ke nilai semula.
const PURCHASE_REVERSAL_OUTBOUND = new Set(['GRN_REVERSAL', 'VENDOR_RETURN', 'STOCK_REVERSAL']);

/** Masuk pembelian: harga baris Rp0 yang dikirim eksplisit (barang bonus) tetap harga beli, menurunkan rata-rata. */
export const PURCHASE_INBOUND = new Set(['GRN', 'VENDOR_RETURN_REJECTED']);

const MEMO_ITEM_ROLES = new Set(['FINISHED_GOOD', 'SEMI_FINISHED']);

/** Mutasi hasil produksi & distribusinya: selalu memo qty, apa pun itemRole produknya. */
export const MEMO_SOURCE_TYPES = new Set(['FP_RESULT', 'FP_RESULT_WASTE', 'FP_DIST', 'FP_DIST_RETURN']);

export function isMemoCostItem(product: { itemRole?: string | null }): boolean {
  return MEMO_ITEM_ROLES.has(String(product.itemRole || ''));
}

function hasExplicitCost(v: number | string | null | undefined): boolean {
  return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;
}

export type AvgCostState = { qty: number; avg: number };

export type LineCostInput = {
  sourceType: string;
  delta: number;
  /** Harga per satuan dasar dari pemanggil (boleh kosong). */
  lineUnitCost?: number | null;
  /** products.hargaBeli — cadangan bila rata-rata belum pernah terbentuk. */
  hargaBeli?: number | string | null;
  itemRole?: string | null;
};

export type LineCostResult = {
  /** Harga yang ditulis ke kartu bila costingV2 aktif. */
  unitCost: number;
  costSource: StockCostSource;
  /** Status rata-rata setelah baris ini (selalu dihitung, juga saat flag mati). */
  next: AvgCostState;
};

function positive(n: number | string | null | undefined): number {
  const v = roundUnitCost(n);
  return v > 0 ? v : 0;
}

/** Terapkan satu baris mutasi ke status rata-rata bergerak. */
export function applyLineCost(state: AvgCostState, input: LineCostInput): LineCostResult {
  const qty = roundStockQty(state.qty);
  const avg = roundUnitCost(state.avg);
  const delta = roundStockQty(input.delta);
  const nextQty = roundStockQty(qty + delta);
  const lineCost = positive(input.lineUnitCost);

  if (isMemoCostItem({ itemRole: input.itemRole }) || MEMO_SOURCE_TYPES.has(input.sourceType)) {
    return { unitCost: 0, costSource: 'NON_INVENTORY', next: { qty: nextQty, avg: isMemoCostItem({ itemRole: input.itemRole }) ? 0 : avg } };
  }

  if (delta > 0 && PURCHASE_INBOUND.has(input.sourceType) && !lineCost && hasExplicitCost(input.lineUnitCost)) {
    const base = Math.max(0, qty);
    const nextAvg = base + delta > STOCK_QTY_EPS ? roundUnitCost((base * avg) / (base + delta)) : avg;
    return { unitCost: 0, costSource: 'LINE', next: { qty: nextQty, avg: nextAvg } };
  }

  if (delta > 0) {
    const neutral = AVG_NEUTRAL_INBOUND.has(input.sourceType);
    if ((neutral || !lineCost) && avg > 0) {
      return { unitCost: avg, costSource: 'AVG', next: { qty: nextQty, avg } };
    }
    const cost = lineCost || positive(input.hargaBeli);
    if (!cost) return { unitCost: 0, costSource: 'NONE', next: { qty: nextQty, avg } };
    const base = Math.max(0, qty);
    const nextAvg = roundUnitCost((base * avg + delta * cost) / (base + delta));
    return { unitCost: cost, costSource: lineCost ? 'LINE' : 'PRODUCT_AVG', next: { qty: nextQty, avg: nextAvg } };
  }

  const out = -delta;
  if (PURCHASE_REVERSAL_OUTBOUND.has(input.sourceType) && lineCost) {
    const base = Math.max(0, qty);
    const remaining = roundStockQty(base - out);
    const nextAvg = remaining > STOCK_QTY_EPS
      ? roundUnitCost(Math.max(0, (base * avg - out * lineCost) / remaining))
      : avg;
    return { unitCost: lineCost, costSource: 'LINE', next: { qty: nextQty, avg: nextAvg } };
  }
  if (avg > 0) return { unitCost: avg, costSource: 'AVG', next: { qty: nextQty, avg } };
  const fallback = positive(input.hargaBeli);
  return fallback
    ? { unitCost: fallback, costSource: 'PRODUCT_AVG', next: { qty: nextQty, avg } }
    : { unitCost: 0, costSource: 'NONE', next: { qty: nextQty, avg } };
}

/** Perilaku lama (costingV2 mati): harga baris bila ada, keluar tanpa harga memakai hargaBeli. */
export function legacyLineCost(input: LineCostInput): { unitCost: number; costSource: StockCostSource } {
  if (input.lineUnitCost !== undefined && input.lineUnitCost !== null && Number.isFinite(Number(input.lineUnitCost))) {
    return { unitCost: roundUnitCost(input.lineUnitCost), costSource: 'LINE' };
  }
  if (input.delta < 0) {
    const avg = positive(input.hargaBeli);
    if (avg > 0) return { unitCost: avg, costSource: 'PRODUCT_AVG' };
  }
  return { unitCost: 0, costSource: 'NONE' };
}
