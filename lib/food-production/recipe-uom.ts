/**
 * Konversi satuan dapur (resep) → satuan basis produk (stok / pengadaan).
 *
 * Pengadaan tetap memakai products.satuan (base). Modul ini hanya jalur Food Production.
 * Tidak mengubah aturan integer product_uom pengadaan.
 *
 * Packaged / count base (SAK, BTL, IKAT, …): isi `products.recipeBaseGrams`
 * (1 base unit = N gram) atau `recipeBaseMl`, dan/atau `isiPerKemasan` + `satuanIsi`
 * (1 RTG = 10 SACHET). Non-strict: `nutrition.gramsPerUnit` cadangan konversi GR dan
 * infer dari nama (1kg/150g/600ml/2L) kecuali SKU operasional (shouldSkipRecipeNameInfer).
 * Strict (`strictRecipeConversion`): hanya master.
 */

import {
  parsePackNetFromNama,
  positiveOrNull,
  shouldSkipRecipeNameInfer,
} from './pack-net-from-nama';

export type RecipeUomFamily = 'MASS' | 'VOLUME' | 'COUNT' | 'UNKNOWN';

/** Canonical label + grams (mass) or ml (volume) per 1 unit of that label. */
const MASS_TO_GRAM: Record<string, number> = {
  G: 1,
  GR: 1,
  GRAM: 1,
  ONS: 100,
  KG: 1000,
  KILOGRAM: 1000,
};

const VOLUME_TO_ML: Record<string, number> = {
  ML: 1,
  L: 1000,
  LT: 1000,
  LTR: 1000,
  LITER: 1000,
};

const COUNT_LABELS = new Set([
  'PCS',
  'PC',
  'BUTIR',
  'BTL',
  'BOTOL',
  'IKAT',
  'SAK',
  'PACK',
  'PAK',
  'DUS',
  'BOX',
  'BUAH',
  'LEMBAR',
  'POTONG',
  'PTG',
  'JRG',
  'JERIGEN',
  'ROL',
  'ROLL',
  'BAL',
  'BALL',
  /** Renteng / sachet pack — umum di master SPPG (mis. kaldu RTG). */
  'RTG',
  'RENTENG',
  'RENCENG',
  'SCH',
  'SACHET',
  'BKS',
  'BUNGKUS',
]);

export function normalizeRecipeSatuan(raw: unknown): string {
  return String(raw || '').trim().toUpperCase();
}

export function recipeUomFamily(satuan: string | null | undefined): RecipeUomFamily {
  const s = normalizeRecipeSatuan(satuan);
  if (!s) return 'UNKNOWN';
  if (MASS_TO_GRAM[s] != null) return 'MASS';
  if (VOLUME_TO_ML[s] != null) return 'VOLUME';
  if (COUNT_LABELS.has(s)) return 'COUNT';
  return 'UNKNOWN';
}

const MASS_CANON_ORDER = ['KG', 'KILOGRAM', 'ONS', 'GR', 'G', 'GRAM'];
const VOLUME_CANON_ORDER = ['L', 'LT', 'LTR', 'LITER', 'ML'];

/** Konversi qty antar satuan sefamili (GR↔KG, ML↔L). Null jika keluarga beda / tidak dikenal. */
export function convertQtySameFamily(
  qty: number,
  fromSatuan: string | null | undefined,
  toSatuan: string | null | undefined,
): number | null {
  const n = Number(qty);
  if (!Number.isFinite(n)) return null;
  const from = normalizeRecipeSatuan(fromSatuan);
  const to = normalizeRecipeSatuan(toSatuan);
  if (!from || !to) return null;
  if (from === to) return n;
  const fromFam = recipeUomFamily(from);
  const toFam = recipeUomFamily(to);
  if (fromFam !== toFam) return null;
  if (fromFam === 'MASS') {
    const a = MASS_TO_GRAM[from];
    const b = MASS_TO_GRAM[to];
    if (!(a > 0) || !(b > 0)) return null;
    return n * (a / b);
  }
  if (fromFam === 'VOLUME') {
    const a = VOLUME_TO_ML[from];
    const b = VOLUME_TO_ML[to];
    if (!(a > 0) || !(b > 0)) return null;
    return n * (a / b);
  }
  return null;
}

/**
 * Satuan tampil untuk gabungan rekap: utamakan satuan stok jika sefamili,
 * else satuan "lebih besar" yang muncul (KG > ONS > GR, L > ML).
 */
export function pickCanonicalSatuan(
  satuans: Array<string | null | undefined>,
  preferredBase?: string | null,
): string | null {
  const norms = [...new Set(satuans.map(normalizeRecipeSatuan).filter(Boolean))];
  if (!norms.length) return null;
  const families = new Set(norms.map((s) => recipeUomFamily(s)));
  if (families.size !== 1) return null;
  const fam = [...families][0];
  if (fam !== 'MASS' && fam !== 'VOLUME') {
    return norms.length === 1 ? norms[0] : null;
  }
  const pref = normalizeRecipeSatuan(preferredBase);
  if (pref && recipeUomFamily(pref) === fam) {
    if (norms.every((s) => convertQtySameFamily(1, s, pref) != null)) return pref;
  }
  const order = fam === 'MASS' ? MASS_CANON_ORDER : VOLUME_CANON_ORDER;
  for (const label of order) {
    if (norms.includes(label)) return label;
  }
  return norms[0];
}

function sameFamilyFoldGroupKey(row: {
  productKode?: string | null;
  kode?: string | null;
  productId?: string | null;
  satuan?: string | null;
}): string {
  const kode = String(row.productKode || row.kode || '').trim().toUpperCase();
  const id = String(row.productId || '').trim();
  const fam = recipeUomFamily(row.satuan);
  if (fam === 'MASS' || fam === 'VOLUME') {
    if (kode) return `kode:${kode}::${fam}`;
    if (id) return `id:${id}::${fam}`;
  }
  return `raw:${kode || id}::${normalizeRecipeSatuan(row.satuan)}`;
}

/**
 * Gabung baris kode (atau productId) yang sama jika satuan sefamili SI.
 * Berlaku umum — bukan SKU tertentu. COUNT / lintas dimensi tetap terpisah.
 */
export function foldSameFamilyQtyLines<T extends {
  productKode?: string | null;
  kode?: string | null;
  productId?: string | null;
  satuan?: string | null;
}>(
  lines: T[],
  getQty: (row: T) => number,
  apply: (row: T, qty: number, satuan: string) => T,
  merge: (a: T, b: T) => T,
  preferredBase?: (row: T) => string | null | undefined,
): T[] {
  const groups = new Map<string, T[]>();
  for (const row of lines) {
    const key = sameFamilyFoldGroupKey(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const out: T[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    const preferred = preferredBase
      ? list.map(preferredBase).find((s) => String(s || '').trim())
      : undefined;
    const canon = pickCanonicalSatuan(list.map((r) => r.satuan), preferred);
    if (!canon) {
      out.push(...list);
      continue;
    }
    const converted: T[] = [];
    let ok = true;
    for (const row of list) {
      const q = convertQtySameFamily(getQty(row), row.satuan, canon);
      if (q == null) {
        ok = false;
        break;
      }
      converted.push(apply(row, q, canon));
    }
    if (!ok || !converted.length) {
      out.push(...list);
      continue;
    }
    out.push(converted.reduce((acc, row) => merge(acc, row)));
  }
  return out;
}

export type RecipeBridgeOptions = {
  /**
   * Flag tenant `strictRecipeConversion`: jembatan GR/ML hanya dari master
   * (recipeBaseGrams/Ml, termasuk tebakan nama yang sudah dikonfirmasi) — tanpa
   * tebakan nama mentah dan tanpa nutrition.gramsPerUnit.
   */
  strict?: boolean;
};

export type RecipeKitchenOpts = RecipeBridgeOptions & {
  recipeBaseGrams?: number | null;
  recipeBaseMl?: number | null;
  gramsPerUnit?: number | null;
  nama?: string | null;
  kode?: string | null;
  isiPerKemasan?: number | null;
  satuanIsi?: string | null;
};

export type RecipeConversionProduct = {
  satuan?: string | null;
  kode?: string | null;
  nama?: string | null;
  /** 1 base unit = N grams (packaged / count base). */
  recipeBaseGrams?: number | null;
  /** 1 base unit = N ml. */
  recipeBaseMl?: number | null;
  /** 1 base unit = N satuanIsi (mis. 1 RTG = 10 SACHET). */
  isiPerKemasan?: number | null;
  satuanIsi?: string | null;
  /** Fallback grams from nutrition master (non-strict saja). */
  nutrition?: { gramsPerUnit?: number | null } | null;
};

/** Asal faktor baris resep — disimpan di snapshot baris untuk audit/review. */
export type RecipeFactorSource = 'IDENTITY' | 'SI' | 'ISI' | 'MASTER' | 'INFERRED' | 'NUTRITION';

export function isiPerKemasanOf(product: { isiPerKemasan?: number | null; satuanIsi?: string | null }): {
  isi: number;
  satuanIsi: string;
} | null {
  const isi = positiveOrNull(product.isiPerKemasan);
  const satuanIsi = normalizeRecipeSatuan(product.satuanIsi);
  if (isi == null || !satuanIsi) return null;
  return { isi, satuanIsi };
}

/**
 * Validasi pasangan isi per kemasan terhadap satuan basis.
 * `null` = valid (termasuk keduanya kosong).
 */
export function validateIsiPerKemasan(
  baseSatuan: string | null | undefined,
  isiPerKemasan: unknown,
  satuanIsi: unknown,
): string | null {
  const hasIsi = isiPerKemasan != null && isiPerKemasan !== '';
  const label = normalizeRecipeSatuan(satuanIsi);
  if (!hasIsi && !label) return null;
  if (!hasIsi || !label) return 'isiPerKemasan dan satuanIsi wajib diisi berpasangan';
  const n = Number(isiPerKemasan);
  if (!Number.isFinite(n) || n <= 0) return 'isiPerKemasan harus angka > 0';
  const base = normalizeRecipeSatuan(baseSatuan);
  if (label === base) return 'satuanIsi tidak boleh sama dengan satuan basis';
  const fam = recipeUomFamily(label);
  if (fam === 'MASS' || fam === 'VOLUME') {
    return 'satuanIsi harus satuan hitung (SACHET, PCS, …); berat/volume pakai recipeBaseGrams/recipeBaseMl';
  }
  const baseFam = recipeUomFamily(base);
  if (baseFam === 'MASS' || baseFam === 'VOLUME') {
    return 'Isi per kemasan hanya untuk produk bersatuan kemasan (PCS, BTL, RTG, …)';
  }
  return null;
}

export type RecipeBridgeGramsSource = 'master' | 'inferred' | 'nutrition' | 'none';
export type RecipeBridgeMlSource = 'master' | 'inferred' | 'none';

export type RecipeBridgeResolved = {
  recipeBaseGrams: number | null;
  recipeBaseMl: number | null;
  source: 'master' | 'inferred' | 'none';
  gramsSource: RecipeBridgeGramsSource;
  mlSource: RecipeBridgeMlSource;
};

function nutritionGramsOf(product: RecipeConversionProduct | RecipeKitchenOpts): number | null {
  if ('nutrition' in product) {
    const fromNutrition = positiveOrNull(product.nutrition?.gramsPerUnit);
    if (fromNutrition != null) return fromNutrition;
  }
  if ('gramsPerUnit' in product) return positiveOrNull(product.gramsPerUnit);
  return null;
}

/**
 * Tebakan jembatan dari nama (mis. "Kaldu 12,5g") per 1 satuan basis.
 * Bila isi per kemasan diisi, berat/volume di nama dianggap per satuanIsi
 * (1 RTG = 10 SACHET × 12,5 g = 125 g).
 */
export function inferRecipeBridgeFromNama(product: {
  kode?: string | null;
  nama?: string | null;
  isiPerKemasan?: number | null;
  satuanIsi?: string | null;
}): { grams: number | null; ml: number | null } {
  if (shouldSkipRecipeNameInfer(product.kode, product.nama)) return { grams: null, ml: null };
  const parsed = parsePackNetFromNama(product.nama);
  const mult = isiPerKemasanOf(product)?.isi ?? 1;
  const scale = (v: number | null) => (v != null ? Math.round(v * mult * 1e6) / 1e6 : null);
  return { grams: scale(parsed.grams), ml: scale(parsed.ml) };
}

/**
 * Master per dimensi (recipeBaseGrams / recipeBaseMl). Non-strict: dimensi kosong diisi
 * infer nama (kecuali skip operasional), lalu nutrition.gramsPerUnit untuk GR.
 * Strict: master saja — tebakan nama harus dikonfirmasi dulu (tersalin ke master).
 */
export function resolveRecipeBridge(
  product: RecipeConversionProduct | RecipeKitchenOpts,
  opts: RecipeBridgeOptions = {},
): RecipeBridgeResolved {
  const strict = opts.strict ?? ('strict' in product ? product.strict === true : false);
  let grams = positiveOrNull(
    'recipeBaseGrams' in product ? product.recipeBaseGrams : undefined,
  );
  let ml = positiveOrNull(product.recipeBaseMl);
  let gramsSource: RecipeBridgeGramsSource = grams != null ? 'master' : 'none';
  let mlSource: RecipeBridgeMlSource = ml != null ? 'master' : 'none';

  if (strict) {
    return {
      recipeBaseGrams: grams,
      recipeBaseMl: ml,
      source: gramsSource === 'master' || mlSource === 'master' ? 'master' : 'none',
      gramsSource,
      mlSource,
    };
  }

  if (grams == null || ml == null) {
    const inferred = inferRecipeBridgeFromNama(product);
    if (grams == null && inferred.grams != null) {
      grams = inferred.grams;
      gramsSource = 'inferred';
    }
    if (ml == null && inferred.ml != null) {
      ml = inferred.ml;
      mlSource = 'inferred';
    }
  }

  if (grams == null) {
    const fromNutrition = nutritionGramsOf(product);
    if (fromNutrition != null) {
      grams = fromNutrition;
      gramsSource = 'nutrition';
    }
  }

  const source: RecipeBridgeResolved['source'] =
    gramsSource === 'master' || mlSource === 'master'
      ? 'master'
      : gramsSource === 'inferred' || mlSource === 'inferred'
        ? 'inferred'
        : 'none';

  return { recipeBaseGrams: grams, recipeBaseMl: ml, source, gramsSource, mlSource };
}

export type RecipeBridgeFactorSource = 'master' | 'inferred' | 'none';

export type RecipeBridgeReview = {
  inferredGrams: number | null;
  inferredMl: number | null;
  factorSource: RecipeBridgeFactorSource;
  proposedKitchenDefault: string;
};

/** Kolom review Excel: master menang; infer hanya jika field master kosong dan bukan skip. */
export function reviewRecipeBridge(product: RecipeConversionProduct): RecipeBridgeReview {
  const inferred = parsePackNetFromNama(product.nama);
  const resolved = resolveRecipeBridge(product);
  return {
    inferredGrams: inferred.grams,
    inferredMl: inferred.ml,
    factorSource: resolved.source,
    proposedKitchenDefault: defaultKitchenSatuan(product.satuan, {
      recipeBaseGrams: product.recipeBaseGrams,
      recipeBaseMl: product.recipeBaseMl,
      gramsPerUnit: product.nutrition?.gramsPerUnit,
      nama: product.nama,
      kode: product.kode,
    }),
  };
}

/** Kitchen satuan options compatible with a product base satuan. */
export function kitchenSatuanOptionsForBase(
  baseSatuan: string | null | undefined,
  opts?: RecipeKitchenOpts,
): string[] {
  const base = normalizeRecipeSatuan(baseSatuan);
  if (!base) return [];
  const family = recipeUomFamily(base);
  const out = new Set<string>([base]);
  const bridge = resolveRecipeBridge({ ...opts, satuan: base });
  if (family === 'MASS') {
    out.add('GR');
    out.add('ONS');
    out.add('KG');
  } else if (family === 'VOLUME') {
    out.add('ML');
    out.add('L');
  } else if (family === 'COUNT' || family === 'UNKNOWN') {
    // Packaged / unknown base (RTG, CRT, …): izinkan GR/ML bila ada jembatan.
    if (bridge.recipeBaseGrams != null) {
      out.add('GR');
      out.add('ONS');
      out.add('KG');
    }
    if (bridge.recipeBaseMl != null) {
      out.add('ML');
      out.add('L');
    }
    const isi = opts ? isiPerKemasanOf(opts) : null;
    if (isi) out.add(isi.satuanIsi);
  }
  return [...out];
}

/** Prefer smallest kitchen unit in the same family as base. */
export function defaultKitchenSatuan(
  baseSatuan: string | null | undefined,
  opts?: RecipeKitchenOpts,
): string {
  const base = normalizeRecipeSatuan(baseSatuan);
  if (!base) return '';
  const family = recipeUomFamily(base);
  if (family === 'MASS') return 'GR';
  if (family === 'VOLUME') return 'ML';
  const bridge = resolveRecipeBridge({ ...opts, satuan: base });
  if (family === 'COUNT' || family === 'UNKNOWN') {
    if (bridge.recipeBaseMl != null && (bridge.gramsSource === 'nutrition' || bridge.gramsSource === 'none')) {
      return 'ML';
    }
    if (bridge.recipeBaseGrams != null) return 'GR';
    if (bridge.recipeBaseMl != null) return 'ML';
  }
  const optsList = kitchenSatuanOptionsForBase(base, opts);
  return optsList[0] || base;
}

export type RecipeConversionOk = {
  factorToBase: number;
  qtyBase: number;
  baseSatuan: string;
  kitchenSatuan: string;
};

export type RecipeConversionErr = { error: string };

function bridgeFactorSource(src: RecipeBridgeGramsSource | RecipeBridgeMlSource): RecipeFactorSource {
  if (src === 'inferred') return 'INFERRED';
  if (src === 'nutrition') return 'NUTRITION';
  return 'MASTER';
}

/**
 * Faktor: qtyBase = qtyKitchen * factorToBase.
 *
 * SI same-family: GR→KG = 0.001, ML→L = 0.001, …
 * Packaged base + GR: recipeBaseGrams (non-strict: juga infer nama / nutrition.gramsPerUnit).
 * Packaged base + satuanIsi: 1 / isiPerKemasan.
 */
export function factorKitchenToBase(
  kitchenSatuan: string | null | undefined,
  product: RecipeConversionProduct,
  opts: RecipeBridgeOptions = {},
): { factorToBase: number; baseSatuan: string; factorSource: RecipeFactorSource } | RecipeConversionErr {
  const kitchen = normalizeRecipeSatuan(kitchenSatuan);
  const base = normalizeRecipeSatuan(product.satuan);
  if (!kitchen) return { error: 'Satuan dapur wajib diisi' };
  if (!base) return { error: 'Satuan basis produk belum ada di master' };

  if (kitchen === base) {
    return { factorToBase: 1, baseSatuan: base, factorSource: 'IDENTITY' };
  }

  const kFam = recipeUomFamily(kitchen);
  const bFam = recipeUomFamily(base);

  if (kFam === 'MASS' && bFam === 'MASS') {
    const kg = MASS_TO_GRAM[kitchen];
    const bg = MASS_TO_GRAM[base];
    if (!(kg > 0) || !(bg > 0)) return { error: `Konversi massa ${kitchen} → ${base} tidak didukung` };
    return { factorToBase: kg / bg, baseSatuan: base, factorSource: 'SI' };
  }

  if (kFam === 'VOLUME' && bFam === 'VOLUME') {
    const km = VOLUME_TO_ML[kitchen];
    const bm = VOLUME_TO_ML[base];
    if (!(km > 0) || !(bm > 0)) return { error: `Konversi volume ${kitchen} → ${base} tidak didukung` };
    return { factorToBase: km / bm, baseSatuan: base, factorSource: 'SI' };
  }

  const isi = isiPerKemasanOf(product);
  if (isi && kitchen === isi.satuanIsi && (bFam === 'COUNT' || bFam === 'UNKNOWN')) {
    return { factorToBase: 1 / isi.isi, baseSatuan: base, factorSource: 'ISI' };
  }

  // Kitchen mass → packaged/count base via explicit grams-per-base-unit.
  if (kFam === 'MASS' && (bFam === 'COUNT' || bFam === 'UNKNOWN')) {
    const bridge = resolveRecipeBridge(product, opts);
    const gramsPerBase = bridge.recipeBaseGrams;
    if (!(gramsPerBase != null && gramsPerBase > 0)) {
      return {
        error: opts.strict
          ? `Produk basis ${base}: isi berat per ${base} (recipeBaseGrams) atau konfirmasi tebakan nama untuk konversi dari ${kitchen}`
          : `Produk basis ${base}: isi recipeBaseGrams (atau nutrition.gramsPerUnit) untuk konversi dari ${kitchen}`,
      };
    }
    const kitchenGrams = MASS_TO_GRAM[kitchen];
    if (!(kitchenGrams > 0)) return { error: `Satuan dapur ${kitchen} tidak dikenali` };
    return {
      factorToBase: kitchenGrams / gramsPerBase,
      baseSatuan: base,
      factorSource: bridgeFactorSource(bridge.gramsSource),
    };
  }

  // Kitchen volume → packaged/count base via explicit ml-per-base-unit.
  if (kFam === 'VOLUME' && (bFam === 'COUNT' || bFam === 'UNKNOWN')) {
    const bridge = resolveRecipeBridge(product, opts);
    const mlPerBase = bridge.recipeBaseMl;
    if (!(mlPerBase != null && mlPerBase > 0)) {
      return {
        error: opts.strict
          ? `Produk basis ${base}: isi volume per ${base} (recipeBaseMl) atau konfirmasi tebakan nama untuk konversi dari ${kitchen}`
          : `Produk basis ${base}: isi recipeBaseMl untuk konversi dari ${kitchen}`,
      };
    }
    const kitchenMl = VOLUME_TO_ML[kitchen];
    if (!(kitchenMl > 0)) return { error: `Satuan dapur ${kitchen} tidak dikenali` };
    return {
      factorToBase: kitchenMl / mlPerBase,
      baseSatuan: base,
      factorSource: bridgeFactorSource(bridge.mlSource),
    };
  }

  if (kFam !== bFam && kFam !== 'UNKNOWN' && bFam !== 'UNKNOWN') {
    return { error: `Tidak bisa konversi lintas dimensi ${kitchen} → ${base}` };
  }

  return { error: `Konversi ${kitchen} → ${base} tidak didukung` };
}

export function toBaseRecipeQty(
  qtyKitchen: number,
  kitchenSatuan: string | null | undefined,
  product: RecipeConversionProduct,
  opts: RecipeBridgeOptions = {},
): RecipeConversionOk | RecipeConversionErr {
  const qty = Number(qtyKitchen);
  if (!Number.isFinite(qty) || qty < 0) {
    return { error: 'Qty dapur harus angka ≥ 0' };
  }
  const factor = factorKitchenToBase(kitchenSatuan, product, opts);
  if ('error' in factor) return factor;
  const qtyBase = Math.round((qty * factor.factorToBase + Number.EPSILON) * 1e9) / 1e9;
  return {
    factorToBase: factor.factorToBase,
    qtyBase,
    baseSatuan: factor.baseSatuan,
    kitchenSatuan: normalizeRecipeSatuan(kitchenSatuan),
  };
}

/** Apply conversion to dual qty fields; returns snapshots for RecipeLine. */
export function convertRecipeLineQtys(input: {
  qtyBesar: number;
  qtyKecil: number;
  kitchenSatuan: string | null | undefined;
  product: RecipeConversionProduct;
  strict?: boolean;
}): {
  qtyBaseBesar: number;
  qtyBaseKecil: number;
  factorToBase: number;
  baseSatuan: string;
  satuan: string;
  factorSource: RecipeFactorSource;
} | RecipeConversionErr {
  const opts = { strict: input.strict === true };
  const factor = factorKitchenToBase(input.kitchenSatuan, input.product, opts);
  if ('error' in factor) return factor;
  const besar = toBaseRecipeQty(input.qtyBesar, input.kitchenSatuan, input.product, opts);
  if ('error' in besar) return besar;
  const kecil = toBaseRecipeQty(input.qtyKecil, input.kitchenSatuan, input.product, opts);
  if ('error' in kecil) return kecil;
  return {
    qtyBaseBesar: besar.qtyBase,
    qtyBaseKecil: kecil.qtyBase,
    factorToBase: besar.factorToBase,
    baseSatuan: besar.baseSatuan,
    satuan: besar.kitchenSatuan,
    factorSource: factor.factorSource,
  };
}

/** Faktor tidak lolos mode ketat (tebakan nama mentah / nutrisi). */
export function isFallbackFactorSource(src: string | null | undefined): boolean {
  return src === 'INFERRED' || src === 'NUTRITION';
}

/**
 * Qty dapur efektif untuk scale MRP: prefer qtyBase* (basis stok).
 * Legacy tanpa qtyBase* → pakai qty dapur (anggap sudah basis).
 */
export function recipeBaseQtyForFamily(
  line: {
    qty?: number;
    qtyBesar?: number;
    qtyKecil?: number;
    pctKecil?: number;
    qtyBaseBesar?: number;
    qtyBaseKecil?: number;
    factorToBase?: number;
  },
  family: 'BESAR' | 'KECIL',
): number {
  const factor = line.factorToBase != null && Number.isFinite(Number(line.factorToBase))
    ? Number(line.factorToBase)
    : null;

  if (family === 'KECIL') {
    if (line.qtyBaseKecil != null && Number.isFinite(Number(line.qtyBaseKecil))) {
      return Number(line.qtyBaseKecil) || 0;
    }
    let dapur = Number(line.qtyKecil);
    if (!Number.isFinite(dapur)) {
      const besar = Number(line.qtyBesar ?? line.qty) || 0;
      const pct = Number(line.pctKecil);
      dapur = Number.isFinite(pct) && pct > 0
        ? Math.round((besar * pct / 100 + Number.EPSILON) * 1e6) / 1e6
        : 0;
    }
    if (factor != null) {
      return Math.round((dapur * factor + Number.EPSILON) * 1e9) / 1e9;
    }
    return dapur;
  }

  if (line.qtyBaseBesar != null && Number.isFinite(Number(line.qtyBaseBesar))) {
    return Number(line.qtyBaseBesar) || 0;
  }
  const dapur = Number(line.qtyBesar ?? line.qty) || 0;
  if (factor != null) {
    return Math.round((dapur * factor + Number.EPSILON) * 1e9) / 1e9;
  }
  return dapur;
}
