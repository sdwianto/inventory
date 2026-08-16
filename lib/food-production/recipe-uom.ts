/**
 * Konversi satuan dapur (resep) → satuan basis produk (stok / pengadaan).
 *
 * Pengadaan tetap memakai products.satuan (base). Modul ini hanya jalur Food Production.
 * Tidak mengubah aturan integer product_uom pengadaan.
 *
 * Packaged / count base (SAK, BTL, IKAT, …): isi `products.recipeBaseGrams`
 * (1 base unit = N gram) atau `recipeBaseMl`. `nutrition.gramsPerUnit` hanya
 * cadangan konversi GR — tidak memblokir infer ML dari nama (1kg/150g/600ml/2L)
 * kecuali SKU operasional (shouldSkipRecipeNameInfer).
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

export type RecipeKitchenOpts = {
  recipeBaseGrams?: number | null;
  recipeBaseMl?: number | null;
  gramsPerUnit?: number | null;
  nama?: string | null;
  kode?: string | null;
};

export type RecipeConversionProduct = {
  satuan?: string | null;
  kode?: string | null;
  nama?: string | null;
  /** 1 base unit = N grams (packaged / count base). */
  recipeBaseGrams?: number | null;
  /** 1 base unit = N ml. */
  recipeBaseMl?: number | null;
  /** Fallback grams from nutrition master. */
  nutrition?: { gramsPerUnit?: number | null } | null;
};

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
 * Master per dimensi (recipeBaseGrams / recipeBaseMl). Dimensi kosong diisi infer nama
 * kecuali skip operasional. nutrition.gramsPerUnit hanya cadangan konversi GR —
 * tidak memblokir infer ML (mis. Minyak …2L + TKPI PCS).
 */
export function resolveRecipeBridge(product: RecipeConversionProduct | RecipeKitchenOpts): RecipeBridgeResolved {
  let grams = positiveOrNull(
    'recipeBaseGrams' in product ? product.recipeBaseGrams : undefined,
  );
  let ml = positiveOrNull(product.recipeBaseMl);
  let gramsSource: RecipeBridgeGramsSource = grams != null ? 'master' : 'none';
  let mlSource: RecipeBridgeMlSource = ml != null ? 'master' : 'none';

  const skipInfer = shouldSkipRecipeNameInfer(product.kode, product.nama);
  if (!skipInfer && (grams == null || ml == null)) {
    const inferred = parsePackNetFromNama(product.nama);
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
  } else if (family === 'COUNT') {
    if (bridge.recipeBaseGrams != null) {
      out.add('GR');
      out.add('ONS');
      out.add('KG');
    }
    if (bridge.recipeBaseMl != null) {
      out.add('ML');
      out.add('L');
    }
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
  if (family === 'COUNT') {
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

/**
 * Faktor: qtyBase = qtyKitchen * factorToBase.
 *
 * SI same-family: GR→KG = 0.001, ML→L = 0.001, …
 * Packaged base + GR: uses recipeBaseGrams / nutrition.gramsPerUnit.
 */
export function factorKitchenToBase(
  kitchenSatuan: string | null | undefined,
  product: RecipeConversionProduct,
): { factorToBase: number; baseSatuan: string } | RecipeConversionErr {
  const kitchen = normalizeRecipeSatuan(kitchenSatuan);
  const base = normalizeRecipeSatuan(product.satuan);
  if (!kitchen) return { error: 'Satuan dapur wajib diisi' };
  if (!base) return { error: 'Satuan basis produk belum ada di master' };

  if (kitchen === base) {
    return { factorToBase: 1, baseSatuan: base };
  }

  const kFam = recipeUomFamily(kitchen);
  const bFam = recipeUomFamily(base);

  if (kFam === 'MASS' && bFam === 'MASS') {
    const kg = MASS_TO_GRAM[kitchen];
    const bg = MASS_TO_GRAM[base];
    if (!(kg > 0) || !(bg > 0)) return { error: `Konversi massa ${kitchen} → ${base} tidak didukung` };
    return { factorToBase: kg / bg, baseSatuan: base };
  }

  if (kFam === 'VOLUME' && bFam === 'VOLUME') {
    const km = VOLUME_TO_ML[kitchen];
    const bm = VOLUME_TO_ML[base];
    if (!(km > 0) || !(bm > 0)) return { error: `Konversi volume ${kitchen} → ${base} tidak didukung` };
    return { factorToBase: km / bm, baseSatuan: base };
  }

  // Kitchen mass → packaged/count base via explicit grams-per-base-unit (master or infer nama).
  if (kFam === 'MASS' && (bFam === 'COUNT' || bFam === 'UNKNOWN')) {
    const gramsPerBase = resolveRecipeBridge(product).recipeBaseGrams;
    if (!(gramsPerBase != null && gramsPerBase > 0)) {
      return {
        error: `Produk basis ${base}: isi recipeBaseGrams (atau nutrition.gramsPerUnit) untuk konversi dari ${kitchen}`,
      };
    }
    const kitchenGrams = MASS_TO_GRAM[kitchen];
    if (!(kitchenGrams > 0)) return { error: `Satuan dapur ${kitchen} tidak dikenali` };
    return { factorToBase: kitchenGrams / gramsPerBase, baseSatuan: base };
  }

  // Kitchen volume → packaged/count base via explicit ml-per-base-unit.
  if (kFam === 'VOLUME' && (bFam === 'COUNT' || bFam === 'UNKNOWN')) {
    const mlPerBase = resolveRecipeBridge(product).recipeBaseMl;
    if (!(mlPerBase != null && mlPerBase > 0)) {
      return {
        error: `Produk basis ${base}: isi recipeBaseMl untuk konversi dari ${kitchen}`,
      };
    }
    const kitchenMl = VOLUME_TO_ML[kitchen];
    if (!(kitchenMl > 0)) return { error: `Satuan dapur ${kitchen} tidak dikenali` };
    return { factorToBase: kitchenMl / mlPerBase, baseSatuan: base };
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
): RecipeConversionOk | RecipeConversionErr {
  const qty = Number(qtyKitchen);
  if (!Number.isFinite(qty) || qty < 0) {
    return { error: 'Qty dapur harus angka ≥ 0' };
  }
  const factor = factorKitchenToBase(kitchenSatuan, product);
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
}): {
  qtyBaseBesar: number;
  qtyBaseKecil: number;
  factorToBase: number;
  baseSatuan: string;
  satuan: string;
} | RecipeConversionErr {
  const besar = toBaseRecipeQty(input.qtyBesar, input.kitchenSatuan, input.product);
  if ('error' in besar) return besar;
  const kecil = toBaseRecipeQty(input.qtyKecil, input.kitchenSatuan, input.product);
  if ('error' in kecil) return kecil;
  return {
    qtyBaseBesar: besar.qtyBase,
    qtyBaseKecil: kecil.qtyBase,
    factorToBase: besar.factorToBase,
    baseSatuan: besar.baseSatuan,
    satuan: besar.kitchenSatuan,
  };
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
