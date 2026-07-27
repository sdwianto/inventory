/**
 * Nutrition Analysis — ADR-001 Phase 3 (inti MBG).
 * Acuan gizi bahan: katalog TKPI (resolve runtime), dengan override products.nutrition bila sudah diisi.
 * Agregasi: Recipe → Menu → Plan → HSL. Acuan %AKG: Tabel 2 MBG (satu kali makan).
 */

import { roundQty } from '@/lib/food-production/material-requirement';
import {
  recipeQtyForFamily,
  splitPorsiByKategoriFamily,
  type RecipeDoc,
  type RecipeLine,
  type RecipePorsiFamily,
} from '@/lib/food-production/recipe';
import type { MenuDoc } from '@/lib/food-production/menu';
import type { ProductionPlanLine } from '@/lib/food-production/production-plan';
import type { ProductionResultLine } from '@/lib/food-production/production-result';
import {
  nutritionFromTkpiCode,
  resolveTkpiCodeByProductName,
  isAmbiguousSatuan,
  type TkpiResolveVia,
} from '@/lib/food-production/tkpi-catalog';
import akgProfilesJson from '@/data/tkpi/akg-profiles.json';

/** Toleransi pemenuhan target MBG (% dari target). */
export const AKG_COMPLIANCE_MIN_PCT = 90;
export const AKG_COMPLIANCE_MAX_PCT = 120;

export type NutritionBasis = 'PER_100G' | 'PER_UNIT';

export interface NutritionFacts {
  basis: NutritionBasis;
  /** Grams per 1 base unit when basis=PER_100G (e.g. 1 KG = 1000). Default 100 for UNIT. */
  gramsPerUnit?: number;
  /** % BDD (bagian dapat dimakan) dari TKPI — diterapkan saat basis=PER_100G. */
  bddPct?: number;
  /** Kode bahan TKPI bila diisi dari katalog. */
  tkpiCode?: string;
  tkpiNama?: string;
  energiKcal: number;
  proteinG: number;
  lemakG: number;
  karbohidratG: number;
  seratG?: number;
  natriumMg?: number;
  gulaG?: number;
  updatedAt?: Date | string;
}

export interface ProductNutritionRef {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  /** Kode TKPI di master produk (bila sudah di-apply). */
  tkpiCode?: string | null;
  nutrition?: NutritionFacts | null;
}

export type NutritionSource = 'stored' | 'tkpi' | 'alias' | 'search';

export interface ResolvedProductNutrition {
  nutrition: NutritionFacts | null;
  source?: NutritionSource;
  tkpiCode?: string;
  warning?: string;
}

export interface NutritionTotals {
  energiKcal: number;
  proteinG: number;
  lemakG: number;
  karbohidratG: number;
  seratG: number;
  natriumMg: number;
  gulaG: number;
}

export interface NutritionLineBreakdown {
  productId: string;
  productKode?: string;
  productNama?: string;
  qty: number;
  satuan?: string;
  contribution: NutritionTotals;
  missing?: boolean;
  source?: NutritionSource;
  tkpiCode?: string;
}

export interface NutritionAnalysis {
  scope: 'recipe' | 'menu' | 'plan' | 'result';
  refId: string;
  refLabel?: string;
  yieldPorsi: number;
  batch: NutritionTotals;
  perPorsi: NutritionTotals;
  lines: NutritionLineBreakdown[];
  missingProductIds: string[];
  warnings: string[];
  akgProfile: string;
  akgDaily: NutritionTotals;
  /** % of daily AKG for one portion (meal). */
  perPorsiAkgPct: Partial<Record<keyof NutritionTotals, number>>;
}

type AkgJsonProfile = {
  key: string;
  label: string;
  energiKcal: number;
  proteinG: number;
  lemakG: number;
  karbohidratG: number;
  seratG: number;
  natriumMg: number;
  gulaG: number;
};

function buildAkgProfiles(): Record<string, NutritionTotals> {
  const out: Record<string, NutritionTotals> = {};
  for (const p of (akgProfilesJson.profiles || []) as AkgJsonProfile[]) {
    out[p.key] = {
      energiKcal: p.energiKcal,
      proteinG: p.proteinG,
      lemakG: p.lemakG,
      karbohidratG: p.karbohidratG,
      seratG: p.seratG,
      natriumMg: p.natriumMg,
      gulaG: p.gulaG,
    };
  }
  return out;
}

/**
 * Acuan gizi **satu kali MBG** (Tabel 2), bukan AKG harian CSV Permenkes.
 * Sumber: data/tkpi/akg-profiles.json — PORSI_KECIL / PORSI_BESAR.
 */
export const AKG_PROFILES: Record<string, NutritionTotals> = buildAkgProfiles();

export const AKG_PROFILE_OPTIONS: Array<{ key: string; label: string }> =
  ((akgProfilesJson.profiles || []) as AkgJsonProfile[])
    .filter((p) => p.key === 'PORSI_KECIL' || p.key === 'PORSI_BESAR')
    .map((p) => ({ key: p.key, label: p.label }));

/** Alias lama / kategori rencana → profil MBG. */
const AKG_KEY_ALIASES: Record<string, string> = {
  ANAK_SD: 'PORSI_KECIL',
  ANAK_7_9: 'PORSI_KECIL',
  ANAK_7_9_TAHUN: 'PORSI_KECIL',
  ANAK_4_6_TAHUN: 'PORSI_KECIL',
  DEWASA: 'PORSI_BESAR',
  LAKI_10_12: 'PORSI_BESAR',
  LAKI_10_12_TAHUN: 'PORSI_BESAR',
  PEREMPUAN_10_12: 'PORSI_BESAR',
  PEREMPUAN_10_12_TAHUN: 'PORSI_BESAR',
};

export function resolveAkgKey(akgProfile?: string): string {
  const raw = String(akgProfile || '').trim();
  if (raw && AKG_PROFILES[raw]) {
    // Prefer canonical MBG keys when alias profile is duplicated.
    const aliased = AKG_KEY_ALIASES[raw];
    if (aliased && AKG_PROFILES[aliased] && (raw === 'ANAK_SD' || raw === 'DEWASA')) {
      return aliased;
    }
    return raw;
  }
  const aliased = raw ? AKG_KEY_ALIASES[raw] : undefined;
  if (aliased && AKG_PROFILES[aliased]) return aliased;
  if (AKG_PROFILES.PORSI_KECIL) return 'PORSI_KECIL';
  if (AKG_PROFILES.ANAK_SD) return 'ANAK_SD';
  return Object.keys(AKG_PROFILES)[0] || 'PORSI_KECIL';
}

export const EMPTY_NUTRITION: NutritionTotals = {
  energiKcal: 0,
  proteinG: 0,
  lemakG: 0,
  karbohidratG: 0,
  seratG: 0,
  natriumMg: 0,
  gulaG: 0,
};

export function roundNut(n: number, digits = 2): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function addNutrition(a: NutritionTotals, b: NutritionTotals): NutritionTotals {
  return {
    energiKcal: roundNut(a.energiKcal + b.energiKcal),
    proteinG: roundNut(a.proteinG + b.proteinG),
    lemakG: roundNut(a.lemakG + b.lemakG),
    karbohidratG: roundNut(a.karbohidratG + b.karbohidratG),
    seratG: roundNut(a.seratG + b.seratG),
    natriumMg: roundNut(a.natriumMg + b.natriumMg),
    gulaG: roundNut(a.gulaG + b.gulaG),
  };
}

export function scaleNutrition(t: NutritionTotals, factor: number): NutritionTotals {
  return {
    energiKcal: roundNut(t.energiKcal * factor),
    proteinG: roundNut(t.proteinG * factor),
    lemakG: roundNut(t.lemakG * factor),
    karbohidratG: roundNut(t.karbohidratG * factor),
    seratG: roundNut(t.seratG * factor),
    natriumMg: roundNut(t.natriumMg * factor),
    gulaG: roundNut(t.gulaG * factor),
  };
}

export function normalizeNutritionFacts(raw: unknown): NutritionFacts | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'nutrition wajib objek' };
  const row = raw as Record<string, unknown>;
  const basisRaw = String(row.basis || 'PER_UNIT').toUpperCase();
  const basis: NutritionBasis = basisRaw === 'PER_100G' ? 'PER_100G' : 'PER_UNIT';
  const num = (k: string, opts?: { required?: boolean; optional?: boolean }): number | { error: string } => {
    const raw = row[k];
    if (opts?.optional && (raw == null || raw === '')) return 0;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) {
      return { error: `${k} harus angka ≥ 0` };
    }
    if (opts?.required && raw == null) return { error: `${k} wajib` };
    return v;
  };
  const energi = num('energiKcal', { required: true });
  if (typeof energi === 'object') return energi;
  const protein = num('proteinG', { required: true });
  if (typeof protein === 'object') return protein;
  const lemak = num('lemakG', { required: true });
  if (typeof lemak === 'object') return lemak;
  const karbo = num('karbohidratG', { required: true });
  if (typeof karbo === 'object') return karbo;
  const serat = num('seratG', { optional: true });
  if (typeof serat === 'object') return serat;
  const natrium = num('natriumMg', { optional: true });
  if (typeof natrium === 'object') return natrium;
  const gula = num('gulaG', { optional: true });
  if (typeof gula === 'object') return gula;
  let gramsPerUnit = row.gramsPerUnit != null ? Number(row.gramsPerUnit) : undefined;
  if (basis === 'PER_100G') {
    if (!(Number.isFinite(gramsPerUnit) && (gramsPerUnit as number) > 0)) {
      gramsPerUnit = 100;
    }
  }
  let bddPct: number | undefined;
  if (row.bddPct != null && row.bddPct !== '') {
    const b = Number(row.bddPct);
    if (Number.isFinite(b) && b > 0 && b <= 100) bddPct = roundNut(b);
  }
  const tkpiCode = row.tkpiCode != null ? String(row.tkpiCode).trim() : undefined;
  const tkpiNama = row.tkpiNama != null ? String(row.tkpiNama).trim() : undefined;
  return {
    basis,
    gramsPerUnit,
    ...(bddPct != null ? { bddPct } : {}),
    ...(tkpiCode ? { tkpiCode } : {}),
    ...(tkpiNama ? { tkpiNama } : {}),
    energiKcal: roundNut(energi),
    proteinG: roundNut(protein),
    lemakG: roundNut(lemak),
    karbohidratG: roundNut(karbo),
    seratG: roundNut(serat),
    natriumMg: roundNut(natrium),
    gulaG: roundNut(gula),
  };
}

function hasCompleteMacros(n: NutritionFacts | null | undefined): boolean {
  if (!n) return false;
  return (
    Number.isFinite(Number(n.energiKcal))
    && Number.isFinite(Number(n.proteinG))
    && Number.isFinite(Number(n.lemakG))
    && Number.isFinite(Number(n.karbohidratG))
  );
}

function viaToSource(via: TkpiResolveVia | 'alias' | 'search'): NutritionSource {
  if (via === 'code') return 'tkpi';
  if (via === 'alias') return 'alias';
  return 'search';
}

/**
 * Resolve gizi produk: stored nutrition → tkpiCode → alias/nama → katalog TKPI.
 * Tidak menulis ke DB; hanya untuk perhitungan analisis.
 */
export function resolveProductNutrition(
  product: ProductNutritionRef | null | undefined,
  lineHint?: { productNama?: string; productKode?: string; satuan?: string },
): ResolvedProductNutrition {
  if (!product && !lineHint) return { nutrition: null };

  const satuan = lineHint?.satuan || product?.satuan;
  const nama = lineHint?.productNama || product?.productNama || '';
  const stored = product?.nutrition;
  const storedGrams = stored && Number(stored.gramsPerUnit) > 0 ? Number(stored.gramsPerUnit) : undefined;
  const ambiguous = isAmbiguousSatuan(satuan);
  const packWarn = ambiguous && !(storedGrams && storedGrams > 0)
    ? `Satuan ${String(satuan).toUpperCase()} tanpa gramsPerUnit — hitungan memakai tebakan gram/unit`
    : undefined;

  if (stored && hasCompleteMacros(stored)) {
    return {
      nutrition: stored,
      source: 'stored',
      tkpiCode: stored.tkpiCode || product?.tkpiCode || undefined,
      warning: packWarn,
    };
  }

  const code = String(
    product?.tkpiCode || stored?.tkpiCode || '',
  ).trim();
  if (code) {
    const fromCode = nutritionFromTkpiCode(code, satuan, storedGrams);
    if (fromCode) {
      return {
        nutrition: fromCode,
        source: 'tkpi',
        tkpiCode: code,
        warning: packWarn,
      };
    }
  }

  const matched = resolveTkpiCodeByProductName(nama);
  if (matched) {
    const fromMatch = nutritionFromTkpiCode(matched.kode, satuan, storedGrams);
    if (fromMatch) {
      return {
        nutrition: fromMatch,
        source: viaToSource(matched.via),
        tkpiCode: matched.kode,
        warning: packWarn,
      };
    }
  }

  return { nutrition: null };
}

/** Nutrition contributed by `qty` of product (in product base unit). */
export function contributionFromProduct(
  qty: number,
  nutrition: NutritionFacts | null | undefined,
): NutritionTotals | null {
  if (!(qty > 0) || !nutrition) return null;
  if (nutrition.basis === 'PER_UNIT') {
    return scaleNutrition({
      energiKcal: nutrition.energiKcal,
      proteinG: nutrition.proteinG,
      lemakG: nutrition.lemakG,
      karbohidratG: nutrition.karbohidratG,
      seratG: nutrition.seratG || 0,
      natriumMg: nutrition.natriumMg || 0,
      gulaG: nutrition.gulaG || 0,
    }, qty);
  }
  const gramsPerUnit = Number(nutrition.gramsPerUnit) > 0 ? Number(nutrition.gramsPerUnit) : 100;
  const bdd = Number(nutrition.bddPct);
  const bddFactor = Number.isFinite(bdd) && bdd > 0 && bdd <= 100 ? bdd / 100 : 1;
  const factor = (qty * gramsPerUnit * bddFactor) / 100;
  return scaleNutrition({
    energiKcal: nutrition.energiKcal,
    proteinG: nutrition.proteinG,
    lemakG: nutrition.lemakG,
    karbohidratG: nutrition.karbohidratG,
    seratG: nutrition.seratG || 0,
    natriumMg: nutrition.natriumMg || 0,
    gulaG: nutrition.gulaG || 0,
  }, factor);
}

export function akgPct(perPorsi: NutritionTotals, daily: NutritionTotals): Partial<Record<keyof NutritionTotals, number>> {
  const keys = Object.keys(EMPTY_NUTRITION) as (keyof NutritionTotals)[];
  const out: Partial<Record<keyof NutritionTotals, number>> = {};
  for (const k of keys) {
    const d = daily[k];
    if (!(d > 0)) continue;
    out[k] = roundNut((perPorsi[k] / d) * 100, 1);
  }
  return out;
}

export function akgProfileForPorsiFamily(family: RecipePorsiFamily): string {
  return family === 'KECIL' ? 'PORSI_KECIL' : 'PORSI_BESAR';
}

/** Saran profil AKG dari daftar kategori baris rencana. */
export function suggestAkgProfileForCategories(
  kategoriLists: Array<string[] | undefined | null>,
): 'PORSI_KECIL' | 'PORSI_BESAR' | 'MIXED' {
  let hasBesar = false;
  let hasKecil = false;
  for (const list of kategoriLists) {
    const { porsiBesar, porsiKecil } = splitPorsiByKategoriFamily(list, 1);
    if (porsiBesar > 0) hasBesar = true;
    if (porsiKecil > 0) hasKecil = true;
  }
  if (hasBesar && hasKecil) return 'MIXED';
  if (hasKecil) return 'PORSI_KECIL';
  return 'PORSI_BESAR';
}

export function akgComplianceWarnings(
  perPorsi: NutritionTotals,
  target: NutritionTotals,
  opts?: { prefix?: string },
): string[] {
  const prefix = opts?.prefix ? `${opts.prefix}: ` : '';
  const out: string[] = [];
  const checks: Array<{ key: keyof NutritionTotals; label: string }> = [
    { key: 'energiKcal', label: 'energi' },
    { key: 'proteinG', label: 'protein' },
  ];
  for (const { key, label } of checks) {
    const t = target[key];
    if (!(t > 0)) continue;
    const pct = (perPorsi[key] / t) * 100;
    if (pct < AKG_COMPLIANCE_MIN_PCT) {
      out.push(`${prefix}${label} ${roundNut(pct, 1)}% target MBG (min ${AKG_COMPLIANCE_MIN_PCT}%)`);
    } else if (pct > AKG_COMPLIANCE_MAX_PCT) {
      out.push(`${prefix}${label} ${roundNut(pct, 1)}% target MBG (max ${AKG_COMPLIANCE_MAX_PCT}%)`);
    }
  }
  return out;
}

function planLineKategoriList(pl: Pick<ProductionPlanLine, 'kategoriPorsiList'> & { kategoriPorsi?: string }): string[] {
  if (pl.kategoriPorsiList?.length) return pl.kategoriPorsiList;
  if (pl.kategoriPorsi) return [pl.kategoriPorsi];
  return [];
}

/** Split target porsi baris menjadi keluarga besar/kecil. Tanpa kategori → semua besar. */
export function splitPlanLinePorsiFamilies(
  pl: Pick<ProductionPlanLine, 'kategoriPorsiList' | 'targetPorsi'> & {
    kategoriPorsi?: string;
    acuanByKategori?: Partial<Record<string, number>> | null;
  },
  acuanFallback?: Partial<Record<string, number>> | null,
): { porsiBesar: number; porsiKecil: number; kategoriList: string[] } {
  const target = Math.max(0, Number(pl.targetPorsi) || 0);
  const kategoriList = planLineKategoriList(pl);
  if (!kategoriList.length) {
    return { porsiBesar: target, porsiKecil: 0, kategoriList };
  }
  const acuan = pl.acuanByKategori ?? acuanFallback ?? null;
  const split = splitPorsiByKategoriFamily(kategoriList, target, acuan);
  return { ...split, kategoriList };
}

export function resolveAkgKeyForPlanLine(input: {
  porsiBesar: number;
  porsiKecil: number;
  akgProfile?: string;
}): string {
  const besar = input.porsiBesar > 0;
  const kecil = input.porsiKecil > 0;
  if (besar && !kecil) return 'PORSI_BESAR';
  if (kecil && !besar) return 'PORSI_KECIL';
  return resolveAkgKey(input.akgProfile);
}

export function analyzeRecipeNutrition(input: {
  recipe: Pick<RecipeDoc, 'id' | 'kode' | 'nama' | 'yieldQty' | 'lines'>;
  productsById: Map<string, ProductNutritionRef>;
  akgProfile?: string;
  /** Keluarga qty bahan: BESAR (qtyBesar) atau KECIL (qtyKecil). Default BESAR. */
  porsiFamily?: RecipePorsiFamily;
}): NutritionAnalysis {
  const { recipe, productsById } = input;
  const porsiFamily: RecipePorsiFamily = input.porsiFamily === 'KECIL' ? 'KECIL' : 'BESAR';
  const akgKey = resolveAkgKey(input.akgProfile || akgProfileForPorsiFamily(porsiFamily));
  const akgDaily = AKG_PROFILES[akgKey] || EMPTY_NUTRITION;
  const yieldPorsi = Number(recipe.yieldQty) > 0 ? Number(recipe.yieldQty) : 1;
  const lines: NutritionLineBreakdown[] = [];
  const missingProductIds: string[] = [];
  const warnings: string[] = [];
  let batch = { ...EMPTY_NUTRITION };

  for (const line of recipe.lines || []) {
    const product = productsById.get(line.productId);
    const productNama = line.productNama || product?.productNama;
    const productKode = line.productKode || product?.productKode;
    const satuan = line.satuan || product?.satuan;
    const qty = recipeQtyForFamily(line, porsiFamily);
    const resolved = resolveProductNutrition(product || {
      productId: line.productId,
      productNama,
      productKode,
      satuan,
    }, { productNama, productKode, satuan });
    const contrib = contributionFromProduct(qty, resolved.nutrition);
    if (resolved.warning) warnings.push(`${productNama || productKode || line.productId}: ${resolved.warning}`);
    if (!contrib) {
      missingProductIds.push(line.productId);
      lines.push({
        productId: line.productId,
        productKode,
        productNama,
        qty,
        satuan,
        contribution: { ...EMPTY_NUTRITION },
        missing: true,
      });
      continue;
    }
    batch = addNutrition(batch, contrib);
    lines.push({
      productId: line.productId,
      productKode,
      productNama,
      qty,
      satuan,
      contribution: contrib,
      source: resolved.source,
      tkpiCode: resolved.tkpiCode,
    });
  }

  if (missingProductIds.length) {
    const missingLabels = lines
      .filter((l) => l.missing)
      .map((l) => l.productNama || l.productKode || l.productId);
    warnings.push(
      `${missingProductIds.length} bahan belum punya data gizi`
      + (missingLabels.length ? ` (${missingLabels.join(', ')})` : '')
      + ' — tidak ketemu di TKPI',
    );
  }

  const perPorsi = scaleNutrition(batch, 1 / yieldPorsi);
  const pct = akgPct(perPorsi, akgDaily);
  warnings.push(...akgComplianceWarnings(perPorsi, akgDaily));
  return {
    scope: 'recipe',
    refId: recipe.id,
    refLabel: recipe.kode || recipe.nama,
    yieldPorsi,
    batch,
    perPorsi,
    lines,
    missingProductIds: [...new Set(missingProductIds)],
    warnings,
    akgProfile: akgKey,
    akgDaily,
    perPorsiAkgPct: pct,
  };
}

/** Estimasi gizi satu baris rencana (bobot besar+kecil sesuai kategori). */
export function analyzePlanLineNutrition(input: {
  recipe: Pick<RecipeDoc, 'id' | 'kode' | 'nama' | 'yieldQty' | 'lines'>;
  productsById: Map<string, ProductNutritionRef>;
  planLine: Pick<ProductionPlanLine, 'kategoriPorsiList' | 'targetPorsi'> & {
    kategoriPorsi?: string;
    acuanByKategori?: Partial<Record<string, number>> | null;
  };
  akgProfile?: string;
  acuanByKategori?: Partial<Record<string, number>> | null;
}): NutritionAnalysis {
  const { recipe, productsById, planLine } = input;
  const { porsiBesar, porsiKecil } = splitPlanLinePorsiFamilies(planLine, input.acuanByKategori);
  const total = porsiBesar + porsiKecil;
  const yieldWeight = total > 0 ? total : 1;

  let batch = { ...EMPTY_NUTRITION };
  const lines: NutritionLineBreakdown[] = [];
  const missingProductIds: string[] = [];
  const warnings: string[] = [];

  const addFamily = (family: RecipePorsiFamily, nPorsi: number) => {
    if (!(nPorsi > 0)) return;
    const a = analyzeRecipeNutrition({
      recipe,
      productsById,
      porsiFamily: family,
      akgProfile: akgProfileForPorsiFamily(family),
    });
    batch = addNutrition(batch, scaleNutrition(a.perPorsi, nPorsi));
    missingProductIds.push(...a.missingProductIds);
    for (const w of a.warnings) {
      if (!/target MBG/.test(w)) warnings.push(`${family === 'KECIL' ? 'Kecil' : 'Besar'}: ${w}`);
    }
    for (const l of a.lines) {
      lines.push({
        ...l,
        contribution: scaleNutrition(l.contribution, nPorsi / (a.yieldPorsi || 1)),
      });
    }
  };

  addFamily('BESAR', porsiBesar);
  addFamily('KECIL', porsiKecil);

  const perPorsi = scaleNutrition(batch, 1 / yieldWeight);
  const akgKey = resolveAkgKeyForPlanLine({
    porsiBesar,
    porsiKecil,
    akgProfile: input.akgProfile,
  });
  const akgDaily = AKG_PROFILES[akgKey] || EMPTY_NUTRITION;
  const pct = akgPct(perPorsi, akgDaily);
  warnings.push(...akgComplianceWarnings(perPorsi, akgDaily));

  return {
    scope: 'recipe',
    refId: recipe.id,
    refLabel: recipe.kode || recipe.nama,
    yieldPorsi: yieldWeight,
    batch,
    perPorsi,
    lines,
    missingProductIds: [...new Set(missingProductIds)],
    warnings: [...new Set(warnings)],
    akgProfile: akgKey,
    akgDaily,
    perPorsiAkgPct: pct,
  };
}

export function analyzeMenuNutrition(input: {
  menu: Pick<MenuDoc, 'id' | 'kode' | 'nama' | 'items'>;
  recipesById: Map<string, RecipeDoc>;
  productsById: Map<string, ProductNutritionRef>;
  akgProfile?: string;
}): NutritionAnalysis | { error: string } {
  const { menu, recipesById, productsById } = input;
  if (!menu.items?.length) return { error: 'Menu tidak punya resep' };

  let batch = { ...EMPTY_NUTRITION };
  const lines: NutritionLineBreakdown[] = [];
  const missingProductIds: string[] = [];
  const warnings: string[] = [];
  let yieldPorsi = 0;

  for (const item of menu.items) {
    const recipe = recipesById.get(item.recipeId);
    if (!recipe) return { error: `Resep ${item.recipeId} tidak ditemukan` };
    const analyzed = analyzeRecipeNutrition({ recipe, productsById, akgProfile: input.akgProfile });
    const factor = Number(item.porsi) || 1;
    yieldPorsi = roundQty(yieldPorsi + factor);
    batch = addNutrition(batch, scaleNutrition(analyzed.perPorsi, factor));
    for (const l of analyzed.lines) {
      lines.push({
        ...l,
        qty: roundQty(l.qty * (factor / (analyzed.yieldPorsi || 1))),
        contribution: scaleNutrition(l.contribution, factor / (analyzed.yieldPorsi || 1)),
        productNama: l.productNama || `${analyzed.refLabel}`,
      });
    }
    missingProductIds.push(...analyzed.missingProductIds);
    warnings.push(...analyzed.warnings.map((w) => `${recipe.kode}: ${w}`));
  }

  if (!yieldPorsi) yieldPorsi = 1;
  const perPorsi = scaleNutrition(batch, 1 / yieldPorsi);
  const akgKey = resolveAkgKey(input.akgProfile);
  const akgDaily = AKG_PROFILES[akgKey] || EMPTY_NUTRITION;
  return {
    scope: 'menu',
    refId: menu.id,
    refLabel: menu.kode || menu.nama,
    yieldPorsi,
    batch,
    perPorsi,
    lines,
    missingProductIds: [...new Set(missingProductIds)],
    warnings: [...new Set(warnings)],
    akgProfile: akgKey,
    akgDaily,
    perPorsiAkgPct: akgPct(perPorsi, akgDaily),
  };
}

export function analyzePlanNutrition(input: {
  planId: string;
  planNo?: string;
  planLines: Array<ProductionPlanLine & {
    kategoriPorsi?: string;
    acuanByKategori?: Partial<Record<string, number>> | null;
  }>;
  menusById: Map<string, MenuDoc>;
  recipesById: Map<string, RecipeDoc>;
  productsById: Map<string, ProductNutritionRef>;
  akgProfile?: string;
  /** Acuan qty per kategori (dari dialog target porsi). */
  acuanByKategori?: Partial<Record<string, number>> | null;
}): NutritionAnalysis | { error: string } {
  const { planLines, menusById, recipesById, productsById } = input;
  if (!planLines?.length) return { error: 'Rencana tidak punya baris resep' };

  let batch = { ...EMPTY_NUTRITION };
  const lines: NutritionLineBreakdown[] = [];
  const missingProductIds: string[] = [];
  const warnings: string[] = [];
  let totalPorsi = 0;
  let sumBesar = 0;
  let sumKecil = 0;

  for (const pl of planLines) {
    const target = Number(pl.targetPorsi) || 0;
    totalPorsi = roundQty(totalPorsi + target);
    const split = splitPlanLinePorsiFamilies(pl, input.acuanByKategori);
    sumBesar += split.porsiBesar;
    sumKecil += split.porsiKecil;

    if (pl.recipeId) {
      const recipe = recipesById.get(pl.recipeId);
      if (!recipe) return { error: `Resep ${pl.recipeId} tidak ditemukan` };
      const lineAnalysis = analyzePlanLineNutrition({
        recipe,
        productsById,
        planLine: pl,
        akgProfile: input.akgProfile,
        acuanByKategori: input.acuanByKategori,
      });
      batch = addNutrition(batch, scaleNutrition(lineAnalysis.perPorsi, target > 0 ? target : lineAnalysis.yieldPorsi));
      missingProductIds.push(...lineAnalysis.missingProductIds);
      for (const w of lineAnalysis.warnings) {
        if (!/target MBG/.test(w)) warnings.push(`${recipe.kode}: ${w}`);
      }
      for (const l of lineAnalysis.lines) {
        lines.push(l);
      }
      continue;
    }

    const menuId = String(pl.menuId || '').trim();
    const menu = menusById.get(menuId);
    if (!menu) return { error: `Menu ${menuId || '?'} tidak ditemukan` };
    // Menu legacy: pakai qty besar; % vs profil user.
    const menuAnalysis = analyzeMenuNutrition({
      menu,
      recipesById,
      productsById,
      akgProfile: input.akgProfile,
    });
    if ('error' in menuAnalysis) return menuAnalysis;
    batch = addNutrition(batch, scaleNutrition(menuAnalysis.perPorsi, target));
    missingProductIds.push(...menuAnalysis.missingProductIds);
    warnings.push(...menuAnalysis.warnings.map((w) => `${menu.kode}: ${w}`));
    for (const l of menuAnalysis.lines) {
      lines.push({
        ...l,
        contribution: scaleNutrition(l.contribution, target / (menuAnalysis.yieldPorsi || 1)),
      });
    }
  }

  if (!totalPorsi) totalPorsi = 1;
  const perPorsi = scaleNutrition(batch, 1 / totalPorsi);
  // Campuran: % vs profil user; murni satu family: pakai target family itu.
  const akgKey = resolveAkgKeyForPlanLine({
    porsiBesar: sumBesar,
    porsiKecil: sumKecil,
    akgProfile: input.akgProfile,
  });
  const akgDaily = AKG_PROFILES[akgKey] || EMPTY_NUTRITION;
  if (missingProductIds.length) {
    warnings.push(`${[...new Set(missingProductIds)].length} bahan belum punya data gizi`);
  }
  warnings.push(...akgComplianceWarnings(perPorsi, akgDaily));

  return {
    scope: 'plan',
    refId: input.planId,
    refLabel: input.planNo,
    yieldPorsi: totalPorsi,
    batch,
    perPorsi,
    lines,
    missingProductIds: [...new Set(missingProductIds)],
    warnings: [...new Set(warnings)],
    akgProfile: akgKey,
    akgDaily,
    perPorsiAkgPct: akgPct(perPorsi, akgDaily),
  };
}

/** Estimasi dari draft baris rencana (belum tersimpan) — sama rumus plan. */
export function analyzePlanDraftNutrition(input: {
  lines: Array<{
    recipeId?: string;
    menuId?: string;
    targetPorsi: number;
    kategoriPorsiList?: string[];
    kategoriPorsi?: string;
    acuanByKategori?: Partial<Record<string, number>> | null;
  }>;
  menusById: Map<string, MenuDoc>;
  recipesById: Map<string, RecipeDoc>;
  productsById: Map<string, ProductNutritionRef>;
  akgProfile?: string;
  acuanByKategori?: Partial<Record<string, number>> | null;
}): NutritionAnalysis | { error: string } {
  return analyzePlanNutrition({
    planId: 'draft',
    planNo: 'Draft',
    planLines: input.lines as ProductionPlanLine[],
    menusById: input.menusById,
    recipesById: input.recipesById,
    productsById: input.productsById,
    akgProfile: input.akgProfile,
    acuanByKategori: input.acuanByKategori,
  });
}

/** AKG aktual dari HSL (actualPorsi). */
export function analyzeResultNutrition(input: {
  resultId: string;
  resultNo?: string;
  resultLines: ProductionResultLine[];
  recipesById: Map<string, RecipeDoc>;
  productsById: Map<string, ProductNutritionRef>;
  akgProfile?: string;
}): NutritionAnalysis | { error: string } {
  const { resultLines, recipesById, productsById } = input;
  if (!resultLines?.length) return { error: 'Hasil tidak punya baris' };

  let batch = { ...EMPTY_NUTRITION };
  const lines: NutritionLineBreakdown[] = [];
  const missingProductIds: string[] = [];
  let totalPorsi = 0;

  for (const rl of resultLines) {
    const actual = Number(rl.actualPorsi) || 0;
    totalPorsi = roundQty(totalPorsi + actual);
    const recipe = recipesById.get(rl.recipeId);
    if (!recipe) return { error: `Resep ${rl.recipeId} tidak ditemukan` };
    const recipeAnalysis = analyzeRecipeNutrition({
      recipe,
      productsById,
      akgProfile: input.akgProfile,
    });
    batch = addNutrition(batch, scaleNutrition(recipeAnalysis.perPorsi, actual));
    missingProductIds.push(...recipeAnalysis.missingProductIds);
    for (const l of recipeAnalysis.lines) {
      lines.push({
        ...l,
        contribution: scaleNutrition(l.contribution, actual / (recipeAnalysis.yieldPorsi || 1)),
      });
    }
  }

  if (!totalPorsi) totalPorsi = 1;
  const perPorsi = scaleNutrition(batch, 1 / totalPorsi);
  const akgKey = resolveAkgKey(input.akgProfile);
  const akgDaily = AKG_PROFILES[akgKey] || EMPTY_NUTRITION;
  return {
    scope: 'result',
    refId: input.resultId,
    refLabel: input.resultNo,
    yieldPorsi: totalPorsi,
    batch,
    perPorsi,
    lines,
    missingProductIds: [...new Set(missingProductIds)],
    warnings: missingProductIds.length
      ? [`${[...new Set(missingProductIds)].length} bahan belum punya data gizi`]
      : [],
    akgProfile: akgKey,
    akgDaily,
    perPorsiAkgPct: akgPct(perPorsi, akgDaily),
  };
}

export type { RecipeLine };
