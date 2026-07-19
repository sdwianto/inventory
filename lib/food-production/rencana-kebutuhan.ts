/** Build day-level material needs from production plans (client preview / print). */

import type { MenuDoc } from '@/lib/food-production/menu';
import type { RecipeDoc } from '@/lib/food-production/recipe';
import {
  roundQty,
  scaleRecipeIngredientQty,
} from '@/lib/food-production/material-requirement';

export type RencanaKebutuhanSource = {
  planNo?: string;
  kitchenNama?: string;
  menuKode?: string;
  recipeKode?: string;
  qty: number;
};

export type RencanaKebutuhanLine = {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qty: number;
  sources: RencanaKebutuhanSource[];
};

export type RencanaKebutuhanPlanInput = {
  noDokumen?: string;
  kitchenNama?: string;
  status?: string;
  lines: Array<{
    menuId: string;
    menuKode?: string;
    targetPorsi: number;
  }>;
};

export function buildRencanaKebutuhanLines(input: {
  plans: RencanaKebutuhanPlanInput[];
  menusById: Map<string, Pick<MenuDoc, 'id' | 'kode' | 'items' | 'aktif'>>;
  recipesById: Map<string, Pick<RecipeDoc, 'id' | 'kode' | 'yieldQty' | 'wastePct' | 'lines' | 'aktif'>>;
}): { lines: RencanaKebutuhanLine[]; errors: string[] } {
  const acc = new Map<string, RencanaKebutuhanLine>();
  const errors: string[] = [];

  for (const plan of input.plans) {
    if (plan.status === 'CANCELLED') continue;
    for (const planLine of plan.lines || []) {
      const menu = input.menusById.get(planLine.menuId);
      if (!menu) {
        errors.push(`Menu ${planLine.menuKode || planLine.menuId} tidak ditemukan`);
        continue;
      }
      if (!menu.items?.length) {
        errors.push(`Menu ${menu.kode || planLine.menuId} belum punya resep`);
        continue;
      }
      const targetPorsi = Number(planLine.targetPorsi) || 0;
      if (targetPorsi <= 0) continue;

      for (const item of menu.items) {
        const recipe = input.recipesById.get(item.recipeId);
        if (!recipe) {
          errors.push(`Resep ${item.recipeId} tidak ditemukan`);
          continue;
        }
        if (!recipe.lines?.length) {
          errors.push(`Resep ${recipe.kode || item.recipeId} belum punya bahan`);
          continue;
        }
        const recipePorsiNeeded = targetPorsi * (Number(item.porsi) || 1);
        const yieldQty = Number(recipe.yieldQty) > 0 ? Number(recipe.yieldQty) : 1;
        const wastePct = Number(recipe.wastePct) || 0;

        for (const rLine of recipe.lines) {
          const add = scaleRecipeIngredientQty(
            Number(rLine.qty) || 0,
            recipePorsiNeeded,
            yieldQty,
            wastePct,
          );
          if (add <= 0) continue;
          const prev = acc.get(rLine.productId) || {
            productId: rLine.productId,
            productKode: rLine.productKode,
            productNama: rLine.productNama,
            satuan: rLine.satuan,
            qty: 0,
            sources: [],
          };
          prev.qty = roundQty(prev.qty + add);
          prev.productKode = prev.productKode || rLine.productKode;
          prev.productNama = prev.productNama || rLine.productNama;
          prev.satuan = prev.satuan || rLine.satuan;
          prev.sources.push({
            planNo: plan.noDokumen,
            kitchenNama: plan.kitchenNama,
            menuKode: menu.kode || planLine.menuKode,
            recipeKode: recipe.kode,
            qty: roundQty(add),
          });
          acc.set(rLine.productId, prev);
        }
      }
    }
  }

  const lines = [...acc.values()].sort((a, b) =>
    String(a.productNama || a.productKode || a.productId)
      .localeCompare(String(b.productNama || b.productKode || b.productId), 'id'),
  );
  return { lines, errors: [...new Set(errors)] };
}

/** Qty bahan untuk satu resep pada target porsi menu. */
export function recipeIngredientNeeds(input: {
  recipe: Pick<RecipeDoc, 'yieldQty' | 'wastePct' | 'lines'>;
  menuTargetPorsi: number;
  recipePerMenuPorsi: number;
}): Array<{
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qty: number;
}> {
  const recipePorsiNeeded = Number(input.menuTargetPorsi) * (Number(input.recipePerMenuPorsi) || 1);
  const yieldQty = Number(input.recipe.yieldQty) > 0 ? Number(input.recipe.yieldQty) : 1;
  const wastePct = Number(input.recipe.wastePct) || 0;
  return (input.recipe.lines || [])
    .map((rLine) => ({
      productId: rLine.productId,
      productKode: rLine.productKode,
      productNama: rLine.productNama,
      satuan: rLine.satuan,
      qty: roundQty(scaleRecipeIngredientQty(
        Number(rLine.qty) || 0,
        recipePorsiNeeded,
        yieldQty,
        wastePct,
      )),
    }))
    .filter((l) => l.qty > 0);
}
