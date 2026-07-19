/**
 * Nutrition Analysis — ADR-001 Phase 3 (inti MBG).
 * Gizi bahan disimpan di products.nutrition; agregasi dari Recipe → Menu → Plan.
 */

import { roundQty } from '@/lib/food-production/material-requirement';
import type { RecipeDoc, RecipeLine } from '@/lib/food-production/recipe';
import type { MenuDoc } from '@/lib/food-production/menu';
import type { ProductionPlanLine } from '@/lib/food-production/production-plan';

export type NutritionBasis = 'PER_100G' | 'PER_UNIT';

export interface NutritionFacts {
  basis: NutritionBasis;
  /** Grams per 1 base unit when basis=PER_100G (e.g. 1 KG = 1000). Default 100 for UNIT. */
  gramsPerUnit?: number;
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
  nutrition?: NutritionFacts | null;
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
}

export interface NutritionAnalysis {
  scope: 'recipe' | 'menu' | 'plan';
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

/** Simplified Indonesian RDA (AKG) — daily intake for school-age child (MBG context). */
export const AKG_PROFILES: Record<string, NutritionTotals> = {
  ANAK_SD: {
    energiKcal: 1850,
    proteinG: 50,
    lemakG: 65,
    karbohidratG: 280,
    seratG: 22,
    natriumMg: 1500,
    gulaG: 50,
  },
  DEWASA: {
    energiKcal: 2150,
    proteinG: 60,
    lemakG: 67,
    karbohidratG: 325,
    seratG: 25,
    natriumMg: 2000,
    gulaG: 50,
  },
};

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
  return {
    basis,
    gramsPerUnit,
    energiKcal: roundNut(energi),
    proteinG: roundNut(protein),
    lemakG: roundNut(lemak),
    karbohidratG: roundNut(karbo),
    seratG: roundNut(serat),
    natriumMg: roundNut(natrium),
    gulaG: roundNut(gula),
  };
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
  const factor = (qty * gramsPerUnit) / 100;
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

export function analyzeRecipeNutrition(input: {
  recipe: Pick<RecipeDoc, 'id' | 'kode' | 'nama' | 'yieldQty' | 'lines'>;
  productsById: Map<string, ProductNutritionRef>;
  akgProfile?: string;
}): NutritionAnalysis {
  const { recipe, productsById } = input;
  const akgKey = input.akgProfile && AKG_PROFILES[input.akgProfile] ? input.akgProfile : 'ANAK_SD';
  const akgDaily = AKG_PROFILES[akgKey];
  const yieldPorsi = Number(recipe.yieldQty) > 0 ? Number(recipe.yieldQty) : 1;
  const lines: NutritionLineBreakdown[] = [];
  const missingProductIds: string[] = [];
  const warnings: string[] = [];
  let batch = { ...EMPTY_NUTRITION };

  for (const line of recipe.lines || []) {
    const product = productsById.get(line.productId);
    const contrib = contributionFromProduct(Number(line.qty), product?.nutrition);
    if (!contrib) {
      missingProductIds.push(line.productId);
      lines.push({
        productId: line.productId,
        productKode: line.productKode || product?.productKode,
        productNama: line.productNama || product?.productNama,
        qty: Number(line.qty),
        satuan: line.satuan || product?.satuan,
        contribution: { ...EMPTY_NUTRITION },
        missing: true,
      });
      continue;
    }
    batch = addNutrition(batch, contrib);
    lines.push({
      productId: line.productId,
      productKode: line.productKode || product?.productKode,
      productNama: line.productNama || product?.productNama,
      qty: Number(line.qty),
      satuan: line.satuan || product?.satuan,
      contribution: contrib,
    });
  }

  if (missingProductIds.length) {
    warnings.push(`${missingProductIds.length} bahan belum punya data gizi`);
  }

  const perPorsi = scaleNutrition(batch, 1 / yieldPorsi);
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
    perPorsiAkgPct: akgPct(perPorsi, akgDaily),
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
  const akgKey = input.akgProfile && AKG_PROFILES[input.akgProfile] ? input.akgProfile : 'ANAK_SD';
  const akgDaily = AKG_PROFILES[akgKey];
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
  planLines: ProductionPlanLine[];
  menusById: Map<string, MenuDoc>;
  recipesById: Map<string, RecipeDoc>;
  productsById: Map<string, ProductNutritionRef>;
  akgProfile?: string;
}): NutritionAnalysis | { error: string } {
  const { planLines, menusById, recipesById, productsById } = input;
  if (!planLines?.length) return { error: 'Rencana tidak punya baris resep' };

  let batch = { ...EMPTY_NUTRITION };
  const lines: NutritionLineBreakdown[] = [];
  const missingProductIds: string[] = [];
  const warnings: string[] = [];
  let totalPorsi = 0;

  for (const pl of planLines) {
    const target = Number(pl.targetPorsi) || 0;
    totalPorsi = roundQty(totalPorsi + target);

    if (pl.recipeId) {
      const recipe = recipesById.get(pl.recipeId);
      if (!recipe) return { error: `Resep ${pl.recipeId} tidak ditemukan` };
      const recipeAnalysis = analyzeRecipeNutrition({
        recipe,
        productsById,
        akgProfile: input.akgProfile,
      });
      batch = addNutrition(batch, scaleNutrition(recipeAnalysis.perPorsi, target));
      missingProductIds.push(...recipeAnalysis.missingProductIds);
      for (const l of recipeAnalysis.lines) {
        lines.push({
          ...l,
          contribution: scaleNutrition(l.contribution, target / (recipeAnalysis.yieldPorsi || 1)),
        });
      }
      continue;
    }

    const menuId = String(pl.menuId || '').trim();
    const menu = menusById.get(menuId);
    if (!menu) return { error: `Menu ${menuId || '?'} tidak ditemukan` };
    const menuAnalysis = analyzeMenuNutrition({
      menu,
      recipesById,
      productsById,
      akgProfile: input.akgProfile,
    });
    if ('error' in menuAnalysis) return menuAnalysis;
    batch = addNutrition(batch, scaleNutrition(menuAnalysis.perPorsi, target));
    missingProductIds.push(...menuAnalysis.missingProductIds);
    for (const l of menuAnalysis.lines) {
      lines.push({
        ...l,
        contribution: scaleNutrition(l.contribution, target / (menuAnalysis.yieldPorsi || 1)),
      });
    }
  }

  if (!totalPorsi) totalPorsi = 1;
  const perPorsi = scaleNutrition(batch, 1 / totalPorsi);
  const akgKey = input.akgProfile && AKG_PROFILES[input.akgProfile] ? input.akgProfile : 'ANAK_SD';
  const akgDaily = AKG_PROFILES[akgKey];
  return {
    scope: 'plan',
    refId: input.planId,
    refLabel: input.planNo,
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
