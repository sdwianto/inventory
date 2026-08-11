/**
 * Cost Accounting — ADR-001 Phase 3.
 * Standard cost dari resep × hargaBeli; actual dari Issue × harga; variance.
 */

import { roundQty } from '@/lib/food-production/material-requirement';
import type { RecipeDoc } from '@/lib/food-production/recipe';
import type { MenuDoc } from '@/lib/food-production/menu';
import type { ProductionPlanLine } from '@/lib/food-production/production-plan';
import type { MaterialIssueLine } from '@/lib/food-production/material-issue';
import type { ProductionResultLine } from '@/lib/food-production/production-result';

export interface ProductCostRef {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  hargaBeli?: number;
}

export interface CostLineBreakdown {
  productId: string;
  productKode?: string;
  productNama?: string;
  qty: number;
  satuan?: string;
  unitCost: number;
  amount: number;
  missingPrice?: boolean;
}

export interface CostTotals {
  totalCost: number;
  perPorsi: number;
  yieldPorsi: number;
  missingPriceCount: number;
}

export interface CostAnalysis {
  scope: 'recipe' | 'menu' | 'plan' | 'actual';
  refId: string;
  refLabel?: string;
  standard: CostTotals;
  actual?: CostTotals;
  variance?: {
    amount: number;
    pct: number;
    perPorsiAmount: number;
  };
  lines: CostLineBreakdown[];
  actualLines?: CostLineBreakdown[];
  warnings: string[];
  targetCostPerPorsi?: number;
  vsTarget?: {
    amount: number;
    pct: number;
  };
}

function money(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function unitCostOf(p: ProductCostRef | undefined): number | null {
  if (!p) return null;
  const v = Number(p.hargaBeli);
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

export function analyzeRecipeStandardCost(input: {
  recipe: Pick<RecipeDoc, 'id' | 'kode' | 'nama' | 'yieldQty' | 'lines' | 'wastePct'>;
  productsById: Map<string, ProductCostRef>;
}): CostAnalysis {
  const { recipe, productsById } = input;
  const yieldPorsi = Number(recipe.yieldQty) > 0 ? Number(recipe.yieldQty) : 1;
  const wasteFactor = 1 + Math.max(0, Number(recipe.wastePct) || 0) / 100;
  const lines: CostLineBreakdown[] = [];
  let total = 0;
  let missing = 0;
  const warnings: string[] = [];

  for (const line of recipe.lines || []) {
    const product = productsById.get(line.productId);
    const unit = unitCostOf(product);
    // Cost per basis produk: prefer qtyBaseBesar (legacy tanpa qtyBase = qty dapur = basis).
    const qtyBase = line.qtyBaseBesar != null && Number.isFinite(Number(line.qtyBaseBesar))
      ? Number(line.qtyBaseBesar)
      : Number(line.qtyBesar ?? line.qty) || 0;
    const qty = roundQty(qtyBase * wasteFactor);
    const satuanLabel = line.baseSatuan || line.satuan || product?.satuan;
    if (unit == null) {
      missing += 1;
      lines.push({
        productId: line.productId,
        productKode: line.productKode || product?.productKode,
        productNama: line.productNama || product?.productNama,
        qty,
        satuan: satuanLabel,
        unitCost: 0,
        amount: 0,
        missingPrice: true,
      });
      continue;
    }
    const amount = money(qty * unit);
    total += amount;
    lines.push({
      productId: line.productId,
      productKode: line.productKode || product?.productKode,
      productNama: line.productNama || product?.productNama,
      qty,
      satuan: satuanLabel,
      unitCost: money(unit),
      amount,
    });
  }

  if (missing) warnings.push(`${missing} bahan tanpa hargaBeli`);
  total = money(total);
  return {
    scope: 'recipe',
    refId: recipe.id,
    refLabel: recipe.kode || recipe.nama,
    standard: {
      totalCost: total,
      perPorsi: money(total / yieldPorsi),
      yieldPorsi,
      missingPriceCount: missing,
    },
    lines,
    warnings,
  };
}

export function analyzeMenuStandardCost(input: {
  menu: Pick<MenuDoc, 'id' | 'kode' | 'nama' | 'items' | 'targetCostPerPorsi'>;
  recipesById: Map<string, RecipeDoc>;
  productsById: Map<string, ProductCostRef>;
}): CostAnalysis | { error: string } {
  const { menu, recipesById, productsById } = input;
  if (!menu.items?.length) return { error: 'Menu tidak punya resep' };

  let total = 0;
  let missing = 0;
  let yieldPorsi = 0;
  const lines: CostLineBreakdown[] = [];
  const warnings: string[] = [];

  for (const item of menu.items) {
    const recipe = recipesById.get(item.recipeId);
    if (!recipe) return { error: `Resep ${item.recipeId} tidak ditemukan` };
    const r = analyzeRecipeStandardCost({ recipe, productsById });
    const factor = Number(item.porsi) || 1;
    yieldPorsi = roundQty(yieldPorsi + factor);
    total += r.standard.perPorsi * factor;
    missing += r.standard.missingPriceCount;
    for (const l of r.lines) {
      lines.push({
        ...l,
        qty: roundQty(l.qty * (factor / (r.standard.yieldPorsi || 1))),
        amount: money(l.amount * (factor / (r.standard.yieldPorsi || 1))),
      });
    }
    warnings.push(...r.warnings.map((w) => `${recipe.kode}: ${w}`));
  }

  if (!yieldPorsi) yieldPorsi = 1;
  total = money(total);
  const perPorsi = money(total / yieldPorsi);
  const target = menu.targetCostPerPorsi != null ? Number(menu.targetCostPerPorsi) : undefined;
  let vsTarget: CostAnalysis['vsTarget'];
  if (target != null && Number.isFinite(target) && target > 0) {
    vsTarget = {
      amount: money(perPorsi - target),
      pct: money(((perPorsi - target) / target) * 100),
    };
  }

  return {
    scope: 'menu',
    refId: menu.id,
    refLabel: menu.kode || menu.nama,
    standard: {
      totalCost: total,
      perPorsi,
      yieldPorsi,
      missingPriceCount: missing,
    },
    lines,
    warnings: [...new Set(warnings)],
    targetCostPerPorsi: target,
    vsTarget,
  };
}

export function analyzePlanStandardCost(input: {
  planId: string;
  planNo?: string;
  planLines: ProductionPlanLine[];
  menusById: Map<string, MenuDoc>;
  recipesById: Map<string, RecipeDoc>;
  productsById: Map<string, ProductCostRef>;
}): CostAnalysis | { error: string } {
  let total = 0;
  let missing = 0;
  let totalPorsi = 0;
  const lines: CostLineBreakdown[] = [];
  const warnings: string[] = [];

  for (const pl of input.planLines || []) {
    const target = Number(pl.targetPorsi) || 0;
    totalPorsi = roundQty(totalPorsi + target);

    if (pl.recipeId) {
      const recipe = input.recipesById.get(pl.recipeId);
      if (!recipe) return { error: `Resep ${pl.recipeId} tidak ditemukan` };
      const m = analyzeRecipeStandardCost({
        recipe,
        productsById: input.productsById,
      });
      total += m.standard.perPorsi * target;
      missing += m.standard.missingPriceCount;
      for (const l of m.lines) {
        lines.push({
          ...l,
          amount: money(l.amount * (target / (m.standard.yieldPorsi || 1))),
          qty: roundQty(l.qty * (target / (m.standard.yieldPorsi || 1))),
        });
      }
      continue;
    }

    const menuId = String(pl.menuId || '').trim();
    const menu = input.menusById.get(menuId);
    if (!menu) return { error: `Menu ${menuId || '?'} tidak ditemukan` };
    const m = analyzeMenuStandardCost({
      menu,
      recipesById: input.recipesById,
      productsById: input.productsById,
    });
    if ('error' in m) return m;
    total += m.standard.perPorsi * target;
    missing += m.standard.missingPriceCount;
    for (const l of m.lines) {
      lines.push({
        ...l,
        amount: money(l.amount * (target / (m.standard.yieldPorsi || 1))),
        qty: roundQty(l.qty * (target / (m.standard.yieldPorsi || 1))),
      });
    }
  }

  if (!totalPorsi) totalPorsi = 1;
  total = money(total);
  return {
    scope: 'plan',
    refId: input.planId,
    refLabel: input.planNo,
    standard: {
      totalCost: total,
      perPorsi: money(total / totalPorsi),
      yieldPorsi: totalPorsi,
      missingPriceCount: missing,
    },
    lines,
    warnings: missing ? [`${missing} baris tanpa harga`] : [],
  };
}

export function analyzeActualCost(input: {
  planId: string;
  planNo?: string;
  issueLines: MaterialIssueLine[];
  resultLines: ProductionResultLine[];
  productsById: Map<string, ProductCostRef>;
  standard?: CostTotals;
}): CostAnalysis {
  const actualLines: CostLineBreakdown[] = [];
  let total = 0;
  let missing = 0;
  const warnings: string[] = [];

  for (const line of input.issueLines || []) {
    const product = input.productsById.get(line.productId);
    const unit = unitCostOf(product);
    const qty = Number(line.qtyIssued) || 0;
    if (!(qty > 0)) continue;
    if (unit == null) {
      missing += 1;
      actualLines.push({
        productId: line.productId,
        productKode: line.productKode || product?.productKode,
        productNama: line.productNama || product?.productNama,
        qty,
        satuan: line.satuan || product?.satuan,
        unitCost: 0,
        amount: 0,
        missingPrice: true,
      });
      continue;
    }
    const amount = money(qty * unit);
    total += amount;
    actualLines.push({
      productId: line.productId,
      productKode: line.productKode || product?.productKode,
      productNama: line.productNama || product?.productNama,
      qty,
      satuan: line.satuan || product?.satuan,
      unitCost: money(unit),
      amount,
    });
  }

  const actualPorsi = roundQty(
    (input.resultLines || []).reduce((s, l) => s + (Number(l.actualPorsi) || 0), 0),
  );
  const yieldPorsi = actualPorsi > 0 ? actualPorsi : 1;
  total = money(total);
  const actual: CostTotals = {
    totalCost: total,
    perPorsi: money(total / yieldPorsi),
    yieldPorsi,
    missingPriceCount: missing,
  };
  if (missing) warnings.push(`${missing} bahan actual tanpa hargaBeli`);
  if (!(actualPorsi > 0)) warnings.push('Belum ada actual porsi (HSL) — per porsi memakai 1');

  let variance: CostAnalysis['variance'];
  if (input.standard) {
    const amount = money(actual.totalCost - input.standard.totalCost);
    const base = input.standard.totalCost > 0 ? input.standard.totalCost : 1;
    variance = {
      amount,
      pct: money((amount / base) * 100),
      perPorsiAmount: money(actual.perPorsi - input.standard.perPorsi),
    };
  }

  return {
    scope: 'actual',
    refId: input.planId,
    refLabel: input.planNo,
    standard: input.standard || {
      totalCost: 0,
      perPorsi: 0,
      yieldPorsi: 0,
      missingPriceCount: 0,
    },
    actual,
    variance,
    lines: [],
    actualLines,
    warnings,
  };
}
