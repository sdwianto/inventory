/** Recipe master (Food BOM) — ADR-001 Sprint 2. */

import {
  KATEGORI_PORSI_LEGACY,
  type KategoriPorsi,
} from '@/lib/food-production/production-plan';
import { normalizeRecipeSatuan, recipeUomFamily } from '@/lib/food-production/recipe-uom';

export const RECIPES_COLLECTION = 'recipes';

/** Kategori menu MBG pada master resep (bukan kategori porsi RPN). */
export const KATEGORI_MENU_OPTIONS = [
  { value: 'KARBOHIDRAT', label: 'Karbohidrat' },
  { value: 'LAUK_NABATI', label: 'Lauk Nabati' },
  { value: 'LAUK_HEWANI', label: 'Lauk Hewani' },
  { value: 'SAYUR', label: 'Sayur' },
  { value: 'BUAH', label: 'Buah' },
  { value: 'SUSU', label: 'Susu' },
  { value: 'GARNISH', label: 'Garnish' },
] as const;

export type KategoriMenu = (typeof KATEGORI_MENU_OPTIONS)[number]['value'];

const KATEGORI_MENU_SET = new Set<string>(KATEGORI_MENU_OPTIONS.map((o) => o.value));

export function isKategoriMenu(v: unknown): v is KategoriMenu {
  return typeof v === 'string' && KATEGORI_MENU_SET.has(v);
}

export function kategoriMenuLabel(v: string | undefined | null): string {
  if (!v) return '—';
  return KATEGORI_MENU_OPTIONS.find((o) => o.value === v)?.label || v;
}

/** Default % untuk porsi kecil / balita relatif terhadap qty besar. */
export const DEFAULT_PCT_KECIL = 100;

/** Beras: gram per penerima, porsi besar / porsi kecil. */
export const SPPG_BERAS_GRAM_BESAR = 55;
export const SPPG_BERAS_GRAM_KECIL = 45;
/** Buah kecil (kelengkeng, anggur, kurma): butir per penerima. */
export const SPPG_BUAH_BUTIR_BESAR = 4;
export const SPPG_BUAH_BUTIR_KECIL = 3;
/** Catatan stok: 100 butir = 1 kg. */
export const SPPG_BUTIR_PER_KG = 100;
/** Ayam potong: 1 potong = 100 g supaya basis ons/kg tetap 1 potong per penerima. */
export const SPPG_AYAM_GRAM_PER_POTONG = 100;

const MASS_GRAMS: Record<string, number> = {
  G: 1,
  GR: 1,
  GRAM: 1,
  ONS: 100,
  KG: 1000,
  KILOGRAM: 1000,
};

/** Kategori yang memakai qty besar (100%). */
export const KATEGORI_PORSI_BESAR_FAMILY = new Set<KategoriPorsi>([
  'PORSI_BESAR',
  'POSYANDU_BUMIL',
  'POSYANDU_BUSUI',
  'ORGANOLEPTIK',
  'POSYANDU_BUMIL_BUSUI',
]);

/** Kategori yang memakai qty kecil (% dari besar). */
export const KATEGORI_PORSI_KECIL_FAMILY = new Set<KategoriPorsi>([
  'PORSI_KECIL',
  'POSYANDU_BALITA',
]);

export type RecipePorsiFamily = 'BESAR' | 'KECIL';

export function recipePorsiFamilyForKategori(
  kategori: string | undefined | null,
): RecipePorsiFamily {
  if (kategori && KATEGORI_PORSI_KECIL_FAMILY.has(kategori as KategoriPorsi)) {
    return 'KECIL';
  }
  return 'BESAR';
}

export interface RecipeLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  /** Alias qtyBesar — kompatibilitas data lama / nutrition / cost (qty dapur). */
  qty: number;
  /** Qty bahan dapur untuk porsi besar & bumil busui (100%). */
  qtyBesar: number;
  /** Persen qty kecil terhadap qty besar (1–100). */
  pctKecil: number;
  /** Derived: qtyBesar × pctKecil / 100 — porsi kecil & balita (qty dapur). */
  qtyKecil: number;
  /** Satuan dapur (boleh GR/ML; tidak harus = products.satuan). */
  satuan?: string;
  uomId?: string;
  /**
   * Qty dalam satuan basis produk (stok / pengadaan).
   * Diisi enrichLines lewat modul recipe-uom.
   */
  qtyBaseBesar?: number;
  qtyBaseKecil?: number;
  /** Snapshot: qtyBase = qtyDapur × factorToBase. */
  factorToBase?: number;
  /** Snapshot label products.satuan saat simpan. */
  baseSatuan?: string;
  notes?: string;
}

export function normalizeRecipeNama(value: unknown): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export interface RecipeDoc {
  id: string;
  tenantId: string;
  kode: string;
  /** Recipe identity (independent from product master). */
  nama: string;
  /**
   * Optional stock output product for hasil produksi.
   * Not required on recipe master — link later / at production if needed.
   */
  finishedGoodProductId?: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  version: number;
  effectiveDate: string;
  /** Yield in portions (porsi) per batch. */
  yieldQty: number;
  /** Kategori menu MBG (Karbohidrat, Lauk, …). */
  kategoriMenu?: KategoriMenu;
  /** Optional waste % standard (0–100). */
  wastePct?: number;
  lines: RecipeLine[];
  catatan?: string;
  /** Optional recipe photo (stored via media API). */
  gambarUrl?: string;
  gambarMediaFile?: string;
  aktif: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function clampPctKecil(raw: unknown, fallback = DEFAULT_PCT_KECIL): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.round(n * 1000) / 1000));
}

export function computeQtyKecil(qtyBesar: number, pctKecil: number): number {
  const besar = Number(qtyBesar) || 0;
  const pct = clampPctKecil(pctKecil);
  return Math.round((besar * pct / 100 + Number.EPSILON) * 1e6) / 1e6;
}

/** Kunci match pengecualian: productId dan/atau productKode. */
export function portionExceptionMatchSet(
  rows: Array<{ productId?: string; productKode?: string }>,
): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    const id = String(row.productId || '').trim();
    const kode = String(row.productKode || '').trim();
    if (id) keys.add(id);
    if (kode) keys.add(kode);
  }
  return keys;
}

export function isFullPortionProduct(
  line: { productId?: string; productKode?: string },
  keys: Set<string>,
): boolean {
  if (!keys.size) return false;
  const id = String(line.productId || '').trim();
  const kode = String(line.productKode || '').trim();
  return Boolean((id && keys.has(id)) || (kode && keys.has(kode)));
}

/**
 * Item di daftar pengecualian: porsi kecil = 100% (qty kecil = qty besar).
 * Tidak mengubah baris yang tidak masuk daftar.
 */
export function applyFullPortionExceptions<T extends {
  productId?: string;
  productKode?: string;
  qty?: number;
  qtyBesar?: number;
  qtyKecil?: number;
  pctKecil?: number;
  qtyBaseBesar?: number;
  qtyBaseKecil?: number;
}>(lines: T[] | undefined | null, keys: Set<string>): T[] {
  const list = lines || [];
  if (!keys.size) return list;
  return list.map((line) => {
    if (!isFullPortionProduct(line, keys)) return line;
    const qtyBesar = Number(line.qtyBesar ?? line.qty) || 0;
    const qtyBaseBesar = line.qtyBaseBesar;
    const next: T = {
      ...line,
      pctKecil: 100,
      qtyKecil: qtyBesar,
    };
    if (line.qtyBesar != null || line.qty != null) {
      next.qty = qtyBesar;
      next.qtyBesar = qtyBesar;
    }
    if (qtyBaseBesar != null && Number.isFinite(Number(qtyBaseBesar))) {
      next.qtyBaseKecil = Number(qtyBaseBesar);
    }
    return next;
  });
}

export function isFullPortionExceptionLine(
  line: { productId?: string; productKode?: string; pctKecil?: number },
  keys?: Set<string> | null,
): boolean {
  if (keys?.size && isFullPortionProduct(line, keys)) return true;
  return Number(line.pctKecil) === 100;
}

function portionLineLabel(line: { productNama?: string | null }): string {
  return String(line.productNama || '').toLowerCase();
}

export function isSppgBerasLine(line: { productNama?: string | null }): boolean {
  return portionLineLabel(line).includes('beras');
}

export function isSppgBuahKecilLine(line: { productNama?: string | null }): boolean {
  const name = portionLineLabel(line);
  return name.includes('kelengkeng')
    || name.includes('klengkeng')
    || name.includes('anggur')
    || name.includes('kurma');
}

/** Daging ayam potongan. Bumbu, kaldu, dan knoor tidak ikut aturan 1 potong. */
export function isSppgAyamPotongLine(line: { productNama?: string | null }): boolean {
  const name = portionLineLabel(line);
  if (!name.includes('ayam')) return false;
  if (/(bumbu|kaldu|knoor|knorr|desaku|penyedap|royco)/.test(name)) return false;
  return name.includes('potong');
}

function roundPortionQty(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

function roundBaseQty(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e9) / 1e9;
}

function massUnitOf(satuan: string | null | undefined): string | null {
  const key = normalizeRecipeSatuan(satuan);
  return MASS_GRAMS[key] ? key : null;
}

function isAlreadyFullPortion(line: {
  qty?: number;
  qtyBesar?: number;
  qtyKecil?: number;
  pctKecil?: number;
}): boolean {
  const besar = Number(line.qtyBesar ?? line.qty) || 0;
  const kecil = Number(line.qtyKecil);
  const pct = Number(line.pctKecil);
  const qtyFull = besar > 0 && Number.isFinite(kecil)
    && Math.abs(kecil - besar) <= Math.max(1e-6, besar * 1e-6);
  const pctFull = Number.isFinite(pct) && Math.abs(pct - 100) <= 0.05;
  if (qtyFull && (pctFull || !Number.isFinite(pct))) return true;
  return pctFull && (!Number.isFinite(kecil) || qtyFull);
}

function rebaseSameFactor(line: {
  qty?: number;
  qtyBesar?: number;
  qtyBaseBesar?: number;
  factorToBase?: number;
}, qtyBesar: number, qtyKecil: number): {
  factorToBase?: number;
  qtyBaseBesar?: number;
  qtyBaseKecil?: number;
} {
  const oldBesar = Number(line.qtyBesar ?? line.qty) || 0;
  let factor = line.factorToBase != null && Number.isFinite(Number(line.factorToBase))
    ? Number(line.factorToBase)
    : null;
  if (factor == null && oldBesar > 0 && line.qtyBaseBesar != null && Number.isFinite(Number(line.qtyBaseBesar))) {
    factor = Number(line.qtyBaseBesar) / oldBesar;
  }
  if (factor == null) return {};
  return {
    factorToBase: factor,
    qtyBaseBesar: roundBaseQty(qtyBesar * factor),
    qtyBaseKecil: roundBaseQty(qtyKecil * factor),
  };
}

type PortionLine = {
  productNama?: string;
  qty?: number;
  qtyBesar?: number;
  qtyKecil?: number;
  pctKecil?: number;
  satuan?: string;
  qtyBaseBesar?: number;
  qtyBaseKecil?: number;
  factorToBase?: number;
  baseSatuan?: string;
};

function applyBerasStandard<T extends PortionLine>(line: T, yieldQty: number): T {
  const unit = massUnitOf(line.satuan) || massUnitOf(line.baseSatuan) || 'KG';
  const grams = MASS_GRAMS[unit];
  const qtyBesar = roundPortionQty(SPPG_BERAS_GRAM_BESAR * yieldQty / grams);
  const qtyKecil = roundPortionQty(SPPG_BERAS_GRAM_KECIL * yieldQty / grams);
  return {
    ...line,
    satuan: line.satuan && massUnitOf(line.satuan) ? line.satuan : unit,
    qty: qtyBesar,
    qtyBesar,
    pctKecil: clampPctKecil((SPPG_BERAS_GRAM_KECIL / SPPG_BERAS_GRAM_BESAR) * 100),
    qtyKecil,
    ...rebaseSameFactor(line, qtyBesar, qtyKecil),
  };
}

function isBuahPieceSatuan(satuan: string | null | undefined): boolean {
  const key = normalizeRecipeSatuan(satuan);
  return key === 'PCS' || key === 'PC' || key === 'BUTIR';
}

function applyBuahStandard<T extends PortionLine>(line: T, yieldQty: number): T {
  const qtyBesar = SPPG_BUAH_BUTIR_BESAR * yieldQty;
  const qtyKecil = SPPG_BUAH_BUTIR_KECIL * yieldQty;
  const pctKecil = clampPctKecil((SPPG_BUAH_BUTIR_KECIL / SPPG_BUAH_BUTIR_BESAR) * 100);
  const baseUnit = massUnitOf(line.baseSatuan);
  if (baseUnit) {
    const factorToBase = (1000 / SPPG_BUTIR_PER_KG) / MASS_GRAMS[baseUnit];
    return {
      ...line,
      satuan: 'PCS',
      qty: qtyBesar,
      qtyBesar,
      pctKecil,
      qtyKecil,
      factorToBase,
      qtyBaseBesar: roundBaseQty(qtyBesar * factorToBase),
      qtyBaseKecil: roundBaseQty(qtyKecil * factorToBase),
      baseSatuan: line.baseSatuan,
    };
  }
  return {
    ...line,
    satuan: 'PCS',
    qty: qtyBesar,
    qtyBesar,
    pctKecil,
    qtyKecil,
    factorToBase: 1,
    qtyBaseBesar: qtyBesar,
    qtyBaseKecil: qtyKecil,
    baseSatuan: line.baseSatuan || 'PCS',
  };
}

function applyAyamStandard<T extends PortionLine>(line: T, yieldQty: number): T {
  const qty = yieldQty;
  const baseUnit = massUnitOf(line.baseSatuan);
  if (baseUnit) {
    const factorToBase = SPPG_AYAM_GRAM_PER_POTONG / MASS_GRAMS[baseUnit];
    const qtyBase = roundBaseQty(qty * factorToBase);
    return {
      ...line,
      satuan: 'Potong',
      qty,
      qtyBesar: qty,
      pctKecil: 100,
      qtyKecil: qty,
      factorToBase,
      qtyBaseBesar: qtyBase,
      qtyBaseKecil: qtyBase,
    };
  }
  return {
    ...line,
    satuan: 'Potong',
    qty,
    qtyBesar: qty,
    pctKecil: 100,
    qtyKecil: qty,
    qtyBaseBesar: qty,
    qtyBaseKecil: qty,
    factorToBase: 1,
    baseSatuan: line.baseSatuan || 'POTONG',
  };
}

function liftLegacySeventy<T extends PortionLine>(line: T): T {
  const qtyBesar = Number(line.qtyBesar ?? line.qty) || 0;
  const next: T = {
    ...line,
    qty: qtyBesar,
    qtyBesar,
    pctKecil: 100,
    qtyKecil: qtyBesar,
  };
  if (line.qtyBaseBesar != null && Number.isFinite(Number(line.qtyBaseBesar))) {
    next.qtyBaseKecil = Number(line.qtyBaseBesar);
  }
  return next;
}

/**
 * Standar porsi SPPG pada salinan baris resep (per yield).
 * Selain beras, buah kecil, dan ayam potong, porsi kecil = 100% porsi besar.
 * Beras 55 g / 45 g, buah kecil 4 / 3 pcs, ayam potong 1 per penerima.
 */
export function applySppgPortionStandards<T extends PortionLine>(
  lines: T[] | undefined | null,
  yieldQty: number,
): T[] {
  const batch = Number(yieldQty) > 0 ? Number(yieldQty) : 1;
  return (lines || []).map((line) => {
    if (isSppgBerasLine(line)) return applyBerasStandard(line, batch);
    if (isSppgBuahKecilLine(line)) return applyBuahStandard(line, batch);
    if (isSppgAyamPotongLine(line)) return applyAyamStandard(line, batch);
    if (isAlreadyFullPortion(line)) return line;
    return liftLegacySeventy(line);
  });
}

/**
 * Konversi dapur PCS/Potong ke basis stok untuk buah kecil dan ayam potong.
 * Dipakai saat simpan resep, karena satuan itu lintas dimensi dengan KG/ONS.
 */
export function sppgStandardBaseFromKitchen(line: PortionLine & { satuan?: string }, baseSatuan: string): {
  satuan: string;
  factorToBase: number;
  qtyBaseBesar: number;
  qtyBaseKecil: number;
  baseSatuan: string;
} | null {
  const kitchen = normalizeRecipeSatuan(line.satuan);
  const base = normalizeRecipeSatuan(baseSatuan);
  const qtyBesar = Number(line.qtyBesar ?? line.qty) || 0;
  const qtyKecil = Number(line.qtyKecil);
  const kecil = Number.isFinite(qtyKecil) ? qtyKecil : qtyBesar;
  if (isSppgBuahKecilLine(line) && isBuahPieceSatuan(kitchen)) {
    const grams = MASS_GRAMS[base];
    if (!grams) return null;
    const factorToBase = (1000 / SPPG_BUTIR_PER_KG) / grams;
    return {
      satuan: 'PCS',
      factorToBase,
      qtyBaseBesar: roundBaseQty(qtyBesar * factorToBase),
      qtyBaseKecil: roundBaseQty(kecil * factorToBase),
      baseSatuan: base,
    };
  }
  if (isSppgAyamPotongLine(line) && (kitchen === 'POTONG' || kitchen === 'PTG')) {
    const grams = MASS_GRAMS[base];
    if (!grams) {
      return {
        satuan: 'Potong',
        factorToBase: 1,
        qtyBaseBesar: roundBaseQty(qtyBesar),
        qtyBaseKecil: roundBaseQty(kecil),
        baseSatuan: base || 'POTONG',
      };
    }
    const factorToBase = SPPG_AYAM_GRAM_PER_POTONG / grams;
    return {
      satuan: 'Potong',
      factorToBase,
      qtyBaseBesar: roundBaseQty(qtyBesar * factorToBase),
      qtyBaseKecil: roundBaseQty(kecil * factorToBase),
      baseSatuan: base,
    };
  }
  return null;
}

/**
 * Waste masak tidak berlaku untuk item pengecualian porsi penuh yang dihitung per unit utuh (PCS/COUNT).
 * Buffer gudang tetap diterapkan di pemanggil.
 */
export function recipeWastePctForLine(
  recipeWastePct: number,
  line: {
    productId?: string;
    productKode?: string;
    productNama?: string;
    pctKecil?: number;
    satuan?: string;
    baseSatuan?: string;
  },
  fullPortionKeys?: Set<string> | null,
): number {
  const waste = Math.max(0, Number(recipeWastePct) || 0);
  if (!(waste > 0)) return 0;
  const family = recipeUomFamily(line.satuan || line.baseSatuan);
  if (family === 'COUNT' && (isSppgBuahKecilLine(line) || isSppgAyamPotongLine(line))) return 0;
  if (!isFullPortionExceptionLine(line, fullPortionKeys)) return waste;
  if (family !== 'COUNT') return waste;
  return 0;
}

/** Resolve dual-qty fields from legacy or new payload. */
export function resolveRecipeLineQtys(row: Record<string, unknown>): {
  qtyBesar: number;
  pctKecil: number;
  qtyKecil: number;
  qty: number;
} | { error: string } {
  const qtyBesarRaw = row.qtyBesar != null ? Number(row.qtyBesar) : Number(row.qty);
  if (!Number.isFinite(qtyBesarRaw) || qtyBesarRaw <= 0) {
    return { error: 'qty besar harus > 0' };
  }
  const pctKecil = row.pctKecil != null || row.pct_kecil != null
    ? clampPctKecil(row.pctKecil ?? row.pct_kecil)
    : DEFAULT_PCT_KECIL;
  const qtyKecil = row.qtyKecil != null && Number.isFinite(Number(row.qtyKecil))
    ? Math.round((Number(row.qtyKecil) + Number.EPSILON) * 1e6) / 1e6
    : computeQtyKecil(qtyBesarRaw, pctKecil);
  return {
    qtyBesar: qtyBesarRaw,
    pctKecil,
    qtyKecil,
    qty: qtyBesarRaw,
  };
}

export function recipeQtyForFamily(
  line: Pick<RecipeLine, 'qty' | 'qtyBesar' | 'qtyKecil' | 'pctKecil'>,
  family: RecipePorsiFamily,
): number {
  if (family === 'KECIL') {
    if (line.qtyKecil != null && Number.isFinite(Number(line.qtyKecil))) {
      return Number(line.qtyKecil) || 0;
    }
    const besar = Number(line.qtyBesar ?? line.qty) || 0;
    return computeQtyKecil(besar, line.pctKecil ?? DEFAULT_PCT_KECIL);
  }
  return Number(line.qtyBesar ?? line.qty) || 0;
}

export function recipeQtyForKategori(
  line: Pick<RecipeLine, 'qty' | 'qtyBesar' | 'qtyKecil' | 'pctKecil'>,
  kategori: string | undefined | null,
): number {
  return recipeQtyForFamily(line, recipePorsiFamilyForKategori(kategori));
}

function acuanQtyForKategori(
  kategori: string,
  acuan: Partial<Record<string, number>>,
): number {
  if (kategori === KATEGORI_PORSI_LEGACY) {
    const split =
      Math.max(0, Number(acuan.POSYANDU_BUMIL) || 0)
      + Math.max(0, Number(acuan.POSYANDU_BUSUI) || 0);
    if (split > 0) return split;
    return Math.max(0, Number(acuan[KATEGORI_PORSI_LEGACY]) || 0);
  }
  if (kategori === 'POSYANDU_BUMIL' || kategori === 'POSYANDU_BUSUI') {
    const own = Math.max(0, Number(acuan[kategori]) || 0);
    if (own > 0) return own;
    const legacy = Math.max(0, Number(acuan[KATEGORI_PORSI_LEGACY]) || 0);
    if (legacy > 0 && kategori === 'POSYANDU_BUMIL') return legacy;
    return 0;
  }
  return Math.max(0, Number(acuan[kategori]) || 0);
}

/**
 * Split target porsi into besar/kecil families from selected categories.
 * Prefer acuan map; fallback: proportional by count of selected categories.
 * Legacy POSYANDU_BUMIL_BUSUI membaca acuan Bumil+Busui (atau sebaliknya).
 */
export function splitPorsiByKategoriFamily(
  kategoriList: string[] | undefined | null,
  targetPorsi: number,
  acuanByKategori?: Partial<Record<string, number>> | null,
): { porsiBesar: number; porsiKecil: number } {
  const list = (kategoriList || []).filter(Boolean);
  const total = Math.max(0, Number(targetPorsi) || 0);
  if (!list.length) {
    return { porsiBesar: total, porsiKecil: 0 };
  }

  const besarCats = list.filter((k) => KATEGORI_PORSI_BESAR_FAMILY.has(k as KategoriPorsi));
  const kecilCats = list.filter((k) => KATEGORI_PORSI_KECIL_FAMILY.has(k as KategoriPorsi));

  if (acuanByKategori) {
    let porsiBesar = 0;
    let porsiKecil = 0;
    for (const k of besarCats) porsiBesar += acuanQtyForKategori(k, acuanByKategori);
    for (const k of kecilCats) porsiKecil += acuanQtyForKategori(k, acuanByKategori);
    const acuanTotal = porsiBesar + porsiKecil;
    if (acuanTotal > 0) {
      // If user overrode targetPorsi, scale families to match total.
      if (total > 0 && Math.abs(acuanTotal - total) > 0.0001) {
        const scale = total / acuanTotal;
        return {
          porsiBesar: Math.round((porsiBesar * scale + Number.EPSILON) * 1e4) / 1e4,
          porsiKecil: Math.round((porsiKecil * scale + Number.EPSILON) * 1e4) / 1e4,
        };
      }
      return { porsiBesar, porsiKecil };
    }
  }

  // Fallback: proportional by category count
  const nBesar = besarCats.length;
  const nKecil = kecilCats.length;
  const n = nBesar + nKecil || list.length;
  if (n === 0) return { porsiBesar: total, porsiKecil: 0 };
  if (nKecil === 0) return { porsiBesar: total, porsiKecil: 0 };
  if (nBesar === 0) return { porsiBesar: 0, porsiKecil: total };
  const porsiBesar = Math.round((total * (nBesar / n) + Number.EPSILON) * 1e4) / 1e4;
  const porsiKecil = Math.round((total - porsiBesar + Number.EPSILON) * 1e4) / 1e4;
  return { porsiBesar, porsiKecil };
}

function finalizeLineQtys(line: RecipeLine): RecipeLine {
  const qtyBesar = Number(line.qtyBesar ?? line.qty) || 0;
  const pctKecil = clampPctKecil(line.pctKecil);
  const qtyKecil = computeQtyKecil(qtyBesar, pctKecil);
  return {
    ...line,
    qty: qtyBesar,
    qtyBesar,
    pctKecil,
    qtyKecil,
  };
}

/** Merge lines with the same productId — sum qty besar, keep first satuan/notes; pct weighted avg. */
export function consolidateRecipeLines(lines: RecipeLine[]): RecipeLine[] {
  const byId = new Map<string, RecipeLine>();
  for (const line of lines) {
    const productId = String(line.productId || '').trim();
    if (!productId) continue;
    const normalized = finalizeLineQtys({ ...line, productId });
    const existing = byId.get(productId);
    if (!existing) {
      byId.set(productId, normalized);
      continue;
    }
    const sumBesar = (Number(existing.qtyBesar) || 0) + (Number(normalized.qtyBesar) || 0);
    // Weighted average pct by qtyBesar contribution
    const w1 = Number(existing.qtyBesar) || 0;
    const w2 = Number(normalized.qtyBesar) || 0;
    const pct = (w1 + w2) > 0
      ? ((Number(existing.pctKecil) || DEFAULT_PCT_KECIL) * w1
        + (Number(normalized.pctKecil) || DEFAULT_PCT_KECIL) * w2) / (w1 + w2)
      : DEFAULT_PCT_KECIL;
    existing.qtyBesar = sumBesar;
    existing.qty = sumBesar;
    existing.pctKecil = clampPctKecil(pct);
    existing.qtyKecil = computeQtyKecil(sumBesar, existing.pctKecil);
    // qtyBase* harus dihitung ulang lewat enrichLines (faktor bisa beda antar baris).
    delete existing.qtyBaseBesar;
    delete existing.qtyBaseKecil;
    delete existing.factorToBase;
    delete existing.baseSatuan;
    if (!existing.satuan && normalized.satuan) existing.satuan = normalized.satuan;
    if (!existing.uomId && normalized.uomId) existing.uomId = normalized.uomId;
    if (!existing.productKode && normalized.productKode) existing.productKode = normalized.productKode;
    if (!existing.productNama && normalized.productNama) existing.productNama = normalized.productNama;
    if (normalized.notes) {
      const a = String(existing.notes || '').trim();
      const b = String(normalized.notes).trim();
      if (b && a !== b) existing.notes = a ? `${a}; ${b}` : b;
    }
  }
  return [...byId.values()];
}

export function normalizeRecipeLines(
  raw: unknown,
  options?: { finishedGoodProductId?: string },
): RecipeLine[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'Resep wajib punya minimal 1 baris bahan' };
  }
  const lines: RecipeLine[] = [];
  const fgId = options?.finishedGoodProductId?.trim() || '';
  const satuanByProduct = new Map<string, string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const productId = String(row?.productId || '').trim();
    if (!productId) return { error: `Baris ${i + 1}: productId wajib` };
    const qtys = resolveRecipeLineQtys(row);
    if ('error' in qtys) return { error: `Baris ${i + 1}: ${qtys.error}` };
    if (fgId && productId === fgId) {
      return { error: `Baris ${i + 1}: barang jadi tidak boleh jadi bahan di resep yang sama` };
    }
    const satuan = row.satuan != null ? String(row.satuan).trim().toUpperCase() : '';
    if (satuan) {
      const prev = satuanByProduct.get(productId);
      if (prev && prev !== satuan) {
        return {
          error: `Baris ${i + 1}: produk yang sama tidak boleh memakai satuan dapur berbeda (${prev} vs ${satuan})`,
        };
      }
      satuanByProduct.set(productId, satuan);
    }
    lines.push({
      productId,
      productKode: row.productKode != null ? String(row.productKode) : undefined,
      productNama: row.productNama != null ? String(row.productNama) : undefined,
      qty: qtys.qty,
      qtyBesar: qtys.qtyBesar,
      pctKecil: qtys.pctKecil,
      qtyKecil: qtys.qtyKecil,
      satuan: row.satuan != null ? String(row.satuan) : undefined,
      uomId: row.uomId != null ? String(row.uomId) : undefined,
      notes: row.notes != null ? String(row.notes).trim() || undefined : undefined,
    });
  }
  const merged = consolidateRecipeLines(lines);
  if (!merged.length) return { error: 'Resep wajib punya minimal 1 baris bahan' };
  for (const line of merged) {
    if (!(line.qtyBesar > 0)) {
      return { error: `Qty besar bahan ${line.productNama || line.productId} harus > 0` };
    }
  }
  return merged;
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
