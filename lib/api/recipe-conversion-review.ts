/**
 * Review konversi resep (mode ketat) — satu sumber untuk layar Review konversi dan
 * migrasi `recompute-recipe-conversion`.
 *
 * Tiap baris resep dibandingkan dengan hasil `convertRecipeLineForProduct(strict)` terhadap
 * produk live (cutover diikuti):
 * - OK      : snapshot sama dengan hasil ketat
 * - STALE   : hasil ketat ada tetapi snapshot beda (faktor cadangan / cutover / belum pernah dihitung)
 * - INVALID : produk belum punya konversi valid (atau satuan dapur kosong)
 */

import type { Db } from 'mongodb';
import { RECIPES_COLLECTION, type RecipeDoc, type RecipeLine } from '@/lib/food-production/recipe';
import {
  convertRecipeLineForProduct,
  type RecipeConversionSource,
} from '@/lib/food-production/recipe-conversion';
import {
  inferRecipeBridgeFromNama,
  isFallbackFactorSource,
  normalizeRecipeSatuan,
  recipeUomFamily,
} from '@/lib/food-production/recipe-uom';
import { loadLiveProductMap, type LiveCatalogProduct } from '@/lib/api/resolve-live-catalog-product';

export type RecipeLineConversionStatus = 'OK' | 'STALE' | 'INVALID';

export type RecipeLineConversionRow = {
  recipeId: string;
  recipeKode: string;
  recipeNama: string;
  recipeAktif: boolean;
  lineIndex: number;
  productId: string;
  liveProductId: string;
  satuan: string;
  baseSatuan: string;
  before: {
    factorToBase: number | null;
    factorSource: string | null;
    qtyBaseBesar: number | null;
    qtyBaseKecil: number | null;
  };
  after: {
    factorToBase: number;
    factorSource: string;
    qtyBaseBesar: number;
    qtyBaseKecil: number;
  } | null;
  status: RecipeLineConversionStatus;
  cutover: boolean;
  error?: string;
  /** Baris hasil hitung ulang: STALE, atau OK yang hanya perlu isi factorSource. */
  nextLine?: RecipeLine;
};

export type ProductConversionReview = {
  productId: string;
  kode: string;
  nama: string;
  satuan: string;
  recipeBaseGrams: number | null;
  recipeBaseMl: number | null;
  isiPerKemasan: number | null;
  satuanIsi: string | null;
  recipeBridgeSource: string | null;
  recipeBridgeConfirmedAt: Date | null;
  nutritionGramsPerUnit: number | null;
  inferred: { grams: number | null; ml: number | null };
  status: RecipeLineConversionStatus;
  /** Baris resep butuh jembatan (GR/ML ke kemasan, atau satuan isi). */
  needsBridge: boolean;
  lines: RecipeLineConversionRow[];
};

export type RecipeConversionReview = {
  products: ProductConversionReview[];
  summary: {
    recipes: number;
    lines: number;
    okLines: number;
    staleLines: number;
    invalidLines: number;
    /** Snapshot tersimpan memakai faktor INFERRED/NUTRITION. */
    fallbackLines: number;
    productsInvalid: number;
    productsStale: number;
  };
};

const PRODUCT_PROJECTION = {
  id: 1,
  kode: 1,
  nama: 1,
  satuan: 1,
  aktif: 1,
  recipeBaseGrams: 1,
  recipeBaseMl: 1,
  isiPerKemasan: 1,
  satuanIsi: 1,
  recipeBridgeSource: 1,
  recipeBridgeConfirmedAt: 1,
  nutrition: 1,
} as const;

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nearlyEqual(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a === b;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
}

function lineNeedsBridge(satuan: string, base: string, isiLabel: string | null): boolean {
  const k = normalizeRecipeSatuan(satuan);
  const b = normalizeRecipeSatuan(base);
  if (!k) return true;
  if (k === b) return false;
  if (isiLabel && k === isiLabel) return true;
  const kf = recipeUomFamily(k);
  const bf = recipeUomFamily(b);
  return kf !== bf || bf === 'COUNT' || bf === 'UNKNOWN';
}

const STATUS_RANK: Record<RecipeLineConversionStatus, number> = { OK: 0, STALE: 1, INVALID: 2 };

/** Nilai satu baris: bandingkan snapshot dengan hasil konversi ketat produk live. */
export function evaluateRecipeLine(
  recipe: Pick<RecipeDoc, 'id' | 'kode' | 'nama' | 'aktif'>,
  line: RecipeLine,
  lineIndex: number,
  live: RecipeConversionSource & { id?: unknown },
): RecipeLineConversionRow {
  const liveId = String(live.id || line.productId);
  const cutover = liveId !== line.productId;
  const before = {
    factorToBase: numOrNull(line.factorToBase),
    factorSource: line.factorSource ? String(line.factorSource) : null,
    qtyBaseBesar: numOrNull(line.qtyBaseBesar),
    qtyBaseKecil: numOrNull(line.qtyBaseKecil),
  };
  const base = {
    recipeId: recipe.id,
    recipeKode: String(recipe.kode || ''),
    recipeNama: String(recipe.nama || ''),
    recipeAktif: recipe.aktif !== false,
    lineIndex,
    productId: line.productId,
    liveProductId: liveId,
    satuan: normalizeRecipeSatuan(line.satuan),
    baseSatuan: normalizeRecipeSatuan(live.satuan as string | undefined),
    before,
    cutover,
  };

  const res = convertRecipeLineForProduct(line, live, { strict: true });
  if (!res.ok) {
    return { ...base, after: null, status: 'INVALID', error: res.error };
  }
  const next = res.line;
  const after = {
    factorToBase: Number(next.factorToBase),
    factorSource: String(next.factorSource || ''),
    qtyBaseBesar: Number(next.qtyBaseBesar),
    qtyBaseKecil: Number(next.qtyBaseKecil),
  };
  if (next.factorSource === 'SPPG_STANDARD') {
    // Standar porsi SPPG diterapkan ulang saat simpan/eksplosi — cukup cek faktor & produk.
    const same = !cutover && nearlyEqual(before.factorToBase, after.factorToBase);
    if (!same) return { ...base, after, status: 'STALE', nextLine: next };
    return before.factorSource === 'SPPG_STANDARD'
      ? { ...base, after, status: 'OK' }
      : { ...base, after, status: 'OK', nextLine: { ...line, factorSource: 'SPPG_STANDARD' } };
  }
  const valuesSame = !cutover
    && nearlyEqual(before.factorToBase, after.factorToBase)
    && nearlyEqual(before.qtyBaseBesar, after.qtyBaseBesar)
    && nearlyEqual(before.qtyBaseKecil, after.qtyBaseKecil)
    && normalizeRecipeSatuan(line.baseSatuan) === normalizeRecipeSatuan(next.baseSatuan)
    && normalizeRecipeSatuan(line.satuan) === normalizeRecipeSatuan(next.satuan);
  if (valuesSame && before.factorSource === after.factorSource) return { ...base, after, status: 'OK' };
  // Angka sama, hanya factorSource beda (kosong, atau tebakan yang kini terkonfirmasi): cukup metadata.
  if (valuesSame) return { ...base, after, status: 'OK', nextLine: next };
  return { ...base, after, status: 'STALE', nextLine: next };
}

export async function loadRecipesForConversion(
  db: Db,
  tenantId: string,
  opts: { recipeIds?: string[] } = {},
): Promise<RecipeDoc[]> {
  const filter: Record<string, unknown> = { tenantId };
  if (opts.recipeIds?.length) filter.id = { $in: opts.recipeIds };
  return db.collection(RECIPES_COLLECTION)
    .find(filter)
    // Dokumen utuh: penulis (migrasi 0001) membuat revisi dari seluruh isi resep.
    .project({ _id: 0 })
    .toArray() as unknown as Promise<RecipeDoc[]>;
}

/** Produk live per id baris resep, lengkap field konversi. */
export async function loadConversionProducts(
  db: Db,
  tenantId: string,
  recipes: RecipeDoc[],
): Promise<Map<string, LiveCatalogProduct & Record<string, unknown>>> {
  const ids = [...new Set(recipes.flatMap((r) => (r.lines || []).map((l) => String(l.productId || ''))).filter(Boolean))];
  const liveMap = await loadLiveProductMap(db, tenantId, ids);
  const allIds = [...new Set([...ids, ...[...liveMap.values()].map((p) => String(p.id || ''))].filter(Boolean))];
  const full = allIds.length
    ? await db.collection('products').find({ tenantId, id: { $in: allIds } }).project(PRODUCT_PROJECTION).toArray()
    : [];
  const byId = new Map(full.map((p) => [String(p.id), p as Record<string, unknown>]));
  const out = new Map<string, LiveCatalogProduct & Record<string, unknown>>();
  for (const id of ids) {
    const live = liveMap.get(id);
    const liveId = String(live?.id || id);
    const doc = byId.get(liveId) || (live as Record<string, unknown> | undefined);
    if (doc) out.set(id, { ...(live || {}), ...doc } as LiveCatalogProduct & Record<string, unknown>);
  }
  return out;
}

export async function buildRecipeConversionReview(
  db: Db,
  tenantId: string,
  opts: { includeOk?: boolean; recipeIds?: string[] } = {},
): Promise<RecipeConversionReview> {
  const recipes = await loadRecipesForConversion(db, tenantId, opts);
  const products = await loadConversionProducts(db, tenantId, recipes);

  const byProduct = new Map<string, ProductConversionReview>();
  const summary = {
    recipes: recipes.length,
    lines: 0,
    okLines: 0,
    staleLines: 0,
    invalidLines: 0,
    fallbackLines: 0,
    productsInvalid: 0,
    productsStale: 0,
  };

  for (const recipe of recipes) {
    (recipe.lines || []).forEach((line, idx) => {
      summary.lines += 1;
      if (isFallbackFactorSource(line.factorSource)) summary.fallbackLines += 1;
      const p = products.get(line.productId);
      if (!p) {
        summary.invalidLines += 1;
        const key = line.productId;
        const entry = byProduct.get(key) || {
          productId: key,
          kode: String(line.productKode || ''),
          nama: String(line.productNama || key),
          satuan: normalizeRecipeSatuan(line.baseSatuan),
          recipeBaseGrams: null,
          recipeBaseMl: null,
          isiPerKemasan: null,
          satuanIsi: null,
          recipeBridgeSource: null,
          recipeBridgeConfirmedAt: null,
          nutritionGramsPerUnit: null,
          inferred: { grams: null, ml: null },
          status: 'INVALID' as const,
          needsBridge: true,
          lines: [],
        };
        entry.lines.push({
          recipeId: recipe.id,
          recipeKode: String(recipe.kode || ''),
          recipeNama: String(recipe.nama || ''),
          recipeAktif: recipe.aktif !== false,
          lineIndex: idx,
          productId: line.productId,
          liveProductId: line.productId,
          satuan: normalizeRecipeSatuan(line.satuan),
          baseSatuan: normalizeRecipeSatuan(line.baseSatuan),
          before: {
            factorToBase: numOrNull(line.factorToBase),
            factorSource: line.factorSource ? String(line.factorSource) : null,
            qtyBaseBesar: numOrNull(line.qtyBaseBesar),
            qtyBaseKecil: numOrNull(line.qtyBaseKecil),
          },
          after: null,
          status: 'INVALID',
          cutover: false,
          error: 'Produk tidak ditemukan di master tenant',
        });
        byProduct.set(key, entry);
        return;
      }
      const row = evaluateRecipeLine(recipe, line, idx, p);
      if (row.status === 'OK') summary.okLines += 1;
      else if (row.status === 'STALE') summary.staleLines += 1;
      else summary.invalidLines += 1;

      const key = row.liveProductId;
      let entry = byProduct.get(key);
      if (!entry) {
        const nutrition = p.nutrition && typeof p.nutrition === 'object'
          ? (p.nutrition as { gramsPerUnit?: unknown })
          : undefined;
        entry = {
          productId: key,
          kode: String(p.kode || ''),
          nama: String(p.nama || ''),
          satuan: normalizeRecipeSatuan(p.satuan),
          recipeBaseGrams: numOrNull(p.recipeBaseGrams),
          recipeBaseMl: numOrNull(p.recipeBaseMl),
          isiPerKemasan: numOrNull(p.isiPerKemasan),
          satuanIsi: p.satuanIsi ? normalizeRecipeSatuan(p.satuanIsi) : null,
          recipeBridgeSource: p.recipeBridgeSource ? String(p.recipeBridgeSource) : null,
          recipeBridgeConfirmedAt: (p.recipeBridgeConfirmedAt as Date | undefined) ?? null,
          nutritionGramsPerUnit: numOrNull(nutrition?.gramsPerUnit),
          inferred: inferRecipeBridgeFromNama({
            kode: p.kode,
            nama: p.nama,
            isiPerKemasan: numOrNull(p.isiPerKemasan),
            satuanIsi: p.satuanIsi ? String(p.satuanIsi) : null,
          }),
          status: 'OK',
          needsBridge: false,
          lines: [],
        };
        byProduct.set(key, entry);
      }
      if (STATUS_RANK[row.status] > STATUS_RANK[entry.status]) entry.status = row.status;
      if (lineNeedsBridge(row.satuan, entry.satuan, entry.satuanIsi)) entry.needsBridge = true;
      entry.lines.push(row);
    });
  }

  const list = [...byProduct.values()]
    .filter((p) => opts.includeOk || p.status !== 'OK' || p.needsBridge)
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.nama.localeCompare(b.nama));
  for (const p of byProduct.values()) {
    if (p.status === 'INVALID') summary.productsInvalid += 1;
    else if (p.status === 'STALE') summary.productsStale += 1;
  }
  return { products: list, summary };
}
