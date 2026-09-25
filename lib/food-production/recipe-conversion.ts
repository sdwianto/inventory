/**
 * Konversi satu baris resep ke satuan basis produk — dipakai simpan/impor resep,
 * rebase cutover (MRP), layar Review konversi, dan migrasi recompute.
 */

import {
  recipeQtyForFamily,
  sppgStandardBaseFromKitchen,
  type RecipeLine,
} from '@/lib/food-production/recipe';
import {
  convertRecipeLineQtys,
  defaultKitchenSatuan,
  factorKitchenToBase,
  kitchenSatuanOptionsForBase,
  normalizeRecipeSatuan,
  recipeUomFamily,
  type RecipeConversionProduct,
} from '@/lib/food-production/recipe-uom';

export type RecipeConversionSource = {
  id?: unknown;
  kode?: unknown;
  nama?: unknown;
  satuan?: unknown;
  recipeBaseGrams?: unknown;
  recipeBaseMl?: unknown;
  isiPerKemasan?: unknown;
  satuanIsi?: unknown;
  nutrition?: unknown;
};

function numOrUndef(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function recipeConversionProductOf(p: RecipeConversionSource): RecipeConversionProduct {
  const nutrition = p.nutrition && typeof p.nutrition === 'object'
    ? (p.nutrition as { gramsPerUnit?: number })
    : undefined;
  return {
    satuan: p.satuan != null ? String(p.satuan) : undefined,
    kode: p.kode != null ? String(p.kode) : undefined,
    nama: p.nama != null ? String(p.nama) : undefined,
    recipeBaseGrams: numOrUndef(p.recipeBaseGrams),
    recipeBaseMl: numOrUndef(p.recipeBaseMl),
    isiPerKemasan: numOrUndef(p.isiPerKemasan),
    satuanIsi: p.satuanIsi != null && String(p.satuanIsi).trim() ? String(p.satuanIsi) : undefined,
    nutrition,
  };
}

export type ConvertLineOptions = {
  strict: boolean;
  /**
   * Satuan dapur kosong: non-strict memakai default produk; strict menolak.
   * Rebase cutover menyetel false karena satuan dapur lama sudah tersimpan.
   */
  allowDefaultKitchen?: boolean;
};

export type ConvertLineResult =
  | { ok: true; line: RecipeLine }
  | { ok: false; error: string; code: 'EMPTY_SATUAN' | 'INCOMPATIBLE' | 'NO_BRIDGE' };

/**
 * Hitung snapshot qtyBaseBesar/qtyBaseKecil, factorToBase, baseSatuan, factorSource untuk baris resep
 * terhadap produk `p`. Identitas produk (id/kode/nama) disalin dari `p`.
 */
export function convertRecipeLineForProduct(
  line: RecipeLine,
  p: RecipeConversionSource,
  opts: ConvertLineOptions,
): ConvertLineResult {
  const productConv = recipeConversionProductOf(p);
  const baseSatuan = normalizeRecipeSatuan(productConv.satuan);
  const identity = {
    productId: String(p.id || line.productId),
    productKode: p.kode != null ? String(p.kode) : line.productKode,
    productNama: p.nama != null ? String(p.nama) : line.productNama,
  };
  const namedLine: RecipeLine = {
    ...line,
    productNama: line.productNama || identity.productNama,
    productKode: line.productKode || identity.productKode,
  };

  const standardBase = sppgStandardBaseFromKitchen(namedLine, baseSatuan);
  if (standardBase) {
    return {
      ok: true,
      line: {
        ...namedLine,
        ...identity,
        satuan: standardBase.satuan,
        qtyBaseBesar: standardBase.qtyBaseBesar,
        qtyBaseKecil: standardBase.qtyBaseKecil,
        factorToBase: standardBase.factorToBase,
        baseSatuan: standardBase.baseSatuan,
        factorSource: 'SPPG_STANDARD',
      },
    };
  }

  const kitchenOpts = {
    recipeBaseGrams: productConv.recipeBaseGrams,
    recipeBaseMl: productConv.recipeBaseMl,
    gramsPerUnit: productConv.nutrition?.gramsPerUnit,
    nama: productConv.nama,
    kode: productConv.kode,
    isiPerKemasan: productConv.isiPerKemasan,
    satuanIsi: productConv.satuanIsi,
    strict: opts.strict,
  };
  const allowed = kitchenSatuanOptionsForBase(baseSatuan, kitchenOpts);
  let kitchen = normalizeRecipeSatuan(line.satuan);
  if (!kitchen) {
    if (opts.strict || opts.allowDefaultKitchen === false) {
      return {
        ok: false,
        code: 'EMPTY_SATUAN',
        error: `satuan dapur wajib diisi (pilih: ${allowed.join(', ') || baseSatuan || '—'})`,
      };
    }
    kitchen = defaultKitchenSatuan(baseSatuan, kitchenOpts) || baseSatuan;
  }
  if (kitchen && allowed.length && !allowed.includes(kitchen)) {
    const kFam = recipeUomFamily(kitchen);
    const bFam = recipeUomFamily(baseSatuan);
    const missingBridge = (kFam === 'MASS' || kFam === 'VOLUME') && (bFam === 'COUNT' || bFam === 'UNKNOWN');
    if (missingBridge) {
      const factor = factorKitchenToBase(kitchen, productConv, { strict: opts.strict });
      if ('error' in factor) return { ok: false, code: 'NO_BRIDGE', error: factor.error };
    }
    return {
      ok: false,
      code: 'INCOMPATIBLE',
      error: `satuan dapur ${kitchen} tidak kompatibel dengan basis ${baseSatuan || '—'} (pilih: ${allowed.join(', ')})`,
    };
  }

  const qtyBesar = recipeQtyForFamily(line, 'BESAR');
  const qtyKecil = recipeQtyForFamily(line, 'KECIL');
  const converted = convertRecipeLineQtys({
    qtyBesar,
    qtyKecil,
    kitchenSatuan: kitchen,
    product: productConv,
    strict: opts.strict,
  });
  if ('error' in converted) {
    return { ok: false, code: 'NO_BRIDGE', error: converted.error };
  }

  return {
    ok: true,
    line: {
      ...line,
      ...identity,
      qtyBesar,
      qtyKecil,
      satuan: converted.satuan || kitchen || undefined,
      qtyBaseBesar: converted.qtyBaseBesar,
      qtyBaseKecil: converted.qtyBaseKecil,
      factorToBase: converted.factorToBase,
      baseSatuan: converted.baseSatuan,
      factorSource: converted.factorSource,
    },
  };
}

/**
 * Cutover kode: baris resep menunjuk produk lama, eksekusi memakai produk pengganti.
 * qtyBase* dihitung ulang dengan faktor produk pengganti dari satuan dapur asli.
 * Gagal konversi: strict → `error`; non-strict → identitas saja (angka lama) + `warning`.
 */
export function rebaseRecipeLineToProduct(
  line: RecipeLine,
  live: RecipeConversionSource,
  opts: { strict: boolean },
): { line: RecipeLine; error?: string; warning?: string } {
  const liveId = String(live.id || '').trim();
  if (!liveId || liveId === line.productId) return { line };
  const res = convertRecipeLineForProduct(line, live, {
    strict: opts.strict,
    allowDefaultKitchen: !opts.strict,
  });
  if (res.ok) return { line: res.line };
  const label = String(live.nama || live.kode || liveId);
  const message = `Bahan pengganti "${label}" (cutover dari ${line.productKode || line.productId}): ${res.error}`;
  const identityOnly: RecipeLine = {
    ...line,
    productId: liveId,
    productKode: live.kode != null ? String(live.kode) : line.productKode,
    productNama: live.nama != null ? String(live.nama) : line.productNama,
    baseSatuan: live.satuan != null ? String(live.satuan) : line.baseSatuan,
  };
  if (opts.strict) return { line: identityOnly, error: message };
  return { line: identityOnly, warning: message };
}

/**
 * Baris sangat lama tanpa satuan dapur dan tanpa faktor (atau faktor 1): qty sudah dalam satuan
 * basis produk asli (lihat recipeBaseQtyForFamily). Isi satuan itu supaya lolos mode ketat
 * tanpa mengubah arti. Cutover tanpa baseSatuan tersimpan tidak diisi (basis asli tidak diketahui).
 */
export function backfillLegacyKitchenSatuan(
  line: RecipeLine,
  liveSatuan: string | null | undefined,
  cutover: boolean,
): { line: RecipeLine; filled: boolean } {
  if (normalizeRecipeSatuan(line.satuan)) return { line, filled: false };
  const factor = line.factorToBase != null ? Number(line.factorToBase) : null;
  if (factor != null && Math.abs(factor - 1) > 1e-12) return { line, filled: false };
  const base = normalizeRecipeSatuan(line.baseSatuan) || (cutover ? '' : normalizeRecipeSatuan(liveSatuan));
  if (!base) return { line, filled: false };
  return { line: { ...line, satuan: base }, filled: true };
}

/**
 * Baris resep yang dipakai eksekusi (MRP, daftar resep).
 * Non-strict: snapshot tersimpan, kecuali cutover yang dihitung ulang (gagal → warning).
 * Strict: selalu dihitung ulang dari master produk live, jadi snapshot basi atau berfaktor
 * tebakan/nutrisi tidak pernah dipakai. Gagal → `error` (pemanggil memblokir).
 */
export function resolveRecipeLineForExecution(
  line: RecipeLine,
  live: RecipeConversionSource | null | undefined,
  opts: { strict: boolean },
): { line: RecipeLine; error?: string; warning?: string } {
  if (!opts.strict) {
    if (!live?.id) return { line };
    return rebaseRecipeLineToProduct(line, live, opts);
  }
  const label = line.productNama || line.productKode || line.productId;
  if (!live?.id) {
    return { line, error: `Bahan "${label}": produk tidak ditemukan di master tenant` };
  }
  const cutover = String(live.id) !== line.productId;
  const prepped = backfillLegacyKitchenSatuan(line, live.satuan != null ? String(live.satuan) : '', cutover);
  if (cutover) return rebaseRecipeLineToProduct(prepped.line, live, opts);
  const res = convertRecipeLineForProduct(prepped.line, live, { strict: true, allowDefaultKitchen: false });
  if (!res.ok) return { line, error: `Bahan "${label}": ${res.error}` };
  return { line: res.line };
}

export type RecipeConversionIssue = {
  productId: string;
  productKode?: string;
  productNama?: string;
  code: 'EMPTY_SATUAN' | 'INCOMPATIBLE' | 'NO_BRIDGE' | 'NOT_FOUND' | 'INACTIVE' | 'ROLE';
  error: string;
};

export function formatRecipeConversionIssues(issues: RecipeConversionIssue[]): string {
  const head = `Konversi resep belum valid untuk ${issues.length} bahan`;
  const body = issues
    .map((i) => `${i.productNama || i.productKode || i.productId}: ${i.error}`)
    .join('; ');
  return `${head} — ${body}. Lengkapi di Review konversi resep.`;
}
