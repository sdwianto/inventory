/** Build day-level material needs from production plans (client preview / print). */

import type { MenuDoc } from '@/lib/food-production/menu';
import {
  recipeQtyForFamily,
  splitPorsiByKategoriFamily,
  type RecipeDoc,
} from '@/lib/food-production/recipe';
import {
  roundQty,
  scaleRecipeIngredientQty,
} from '@/lib/food-production/material-requirement';
import {
  applyRecipeBufferQty,
  getRecipeBufferPct,
  materialExcludedSet,
  materialOverrideKey,
  materialOverridesMap,
  resolvePlanLineRecipeSlots,
  type PlanMaterialOverride,
} from '@/lib/food-production/production-plan';

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
  kategoriPorsiList?: string[];
  materialOverrides?: PlanMaterialOverride[];
  recipeBufferPct?: Record<string, number>;
  lines: Array<{
    menuId?: string;
    menuKode?: string;
    recipeId?: string;
    recipeKode?: string;
    targetPorsi: number;
    kategoriPorsiList?: string[];
  }>;
};

export function buildRencanaKebutuhanLines(input: {
  plans: RencanaKebutuhanPlanInput[];
  menusById: Map<string, Pick<MenuDoc, 'id' | 'kode' | 'nama'> & {
    items?: MenuDoc['items'];
    aktif?: boolean;
  }>;
  recipesById: Map<string, Pick<RecipeDoc, 'id' | 'kode'> & {
    yieldQty?: number;
    wastePct?: number;
    lines?: RecipeDoc['lines'];
    aktif?: boolean;
  }>;
  acuanByKategori?: Partial<Record<string, number>> | null;
}): { lines: RencanaKebutuhanLine[]; errors: string[] } {
  const acc = new Map<string, RencanaKebutuhanLine>();
  const errors: string[] = [];

  for (const plan of input.plans) {
    if (plan.status === 'CANCELLED') continue;
    const overrideQtyByKey = materialOverridesMap(plan.materialOverrides);
    const excludedKeys = materialExcludedSet(plan.materialOverrides);
    for (const planLine of plan.lines || []) {
      const resolved = resolvePlanLineRecipeSlots(planLine, input.menusById);
      if (!resolved.ok) {
        errors.push(resolved.error);
        continue;
      }
      const targetPorsi = Number(planLine.targetPorsi) || 0;
      if (targetPorsi <= 0) continue;

      const kpList = planLine.kategoriPorsiList?.length
        ? planLine.kategoriPorsiList
        : (plan.kategoriPorsiList || []);
      const split = splitPorsiByKategoriFamily(kpList, targetPorsi, input.acuanByKategori);

      for (const slot of resolved.slots) {
        const recipe = input.recipesById.get(slot.recipeId);
        if (!recipe) {
          errors.push(`Resep ${slot.recipeId} tidak ditemukan`);
          continue;
        }
        if (!recipe.lines?.length) {
          errors.push(`Resep ${recipe.kode || slot.recipeId} belum punya bahan`);
          continue;
        }
        const factor = Number(slot.recipeFactor) || 1;
        const porsiBesarNeeded = split.porsiBesar * factor;
        const porsiKecilNeeded = split.porsiKecil * factor;
        const yieldQty = Number(recipe.yieldQty) > 0 ? Number(recipe.yieldQty) : 1;
        const wastePct = Number(recipe.wastePct) || 0;

        for (const rLine of recipe.lines) {
          const addBesar = scaleRecipeIngredientQty(
            recipeQtyForFamily(rLine, 'BESAR'),
            porsiBesarNeeded,
            yieldQty,
            wastePct,
          );
          const addKecil = scaleRecipeIngredientQty(
            recipeQtyForFamily(rLine, 'KECIL'),
            porsiKecilNeeded,
            yieldQty,
            wastePct,
          );
          const computed = addBesar + addKecil;
          const ovKey = materialOverrideKey(recipe.id, rLine.productId);
          if (excludedKeys.has(ovKey)) continue;
          const bufferPct = getRecipeBufferPct(plan.recipeBufferPct, recipe.id);
          const add = overrideQtyByKey.has(ovKey)
            ? Number(overrideQtyByKey.get(ovKey)) || 0
            : applyRecipeBufferQty(computed, bufferPct);
          if (!(add > 0)) continue;
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
            menuKode: slot.menuKode || planLine.menuKode,
            recipeKode: recipe.kode || planLine.recipeKode,
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

/** Qty bahan untuk satu resep pada target porsi (dual besar/kecil). */
export function recipeIngredientNeeds(input: {
  recipe: {
    yieldQty?: number;
    wastePct?: number;
    lines?: RecipeDoc['lines'];
  };
  menuTargetPorsi: number;
  recipePerMenuPorsi: number;
  kategoriPorsiList?: string[];
  acuanByKategori?: Partial<Record<string, number>> | null;
  /** Buffer persen (mis. 3) — diterapkan ke qty hitungan. */
  bufferPct?: number;
}): Array<{
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qty: number;
  qtyBesarPart?: number;
  qtyKecilPart?: number;
}> {
  const menuFactor = Number(input.recipePerMenuPorsi) || 1;
  const bufferPct = Number(input.bufferPct) || 0;
  const split = splitPorsiByKategoriFamily(
    input.kategoriPorsiList,
    Number(input.menuTargetPorsi) || 0,
    input.acuanByKategori,
  );
  const porsiBesarNeeded = split.porsiBesar * menuFactor;
  const porsiKecilNeeded = split.porsiKecil * menuFactor;
  const yieldQty = Number(input.recipe.yieldQty) > 0 ? Number(input.recipe.yieldQty) : 1;
  const wastePct = Number(input.recipe.wastePct) || 0;
  return (input.recipe.lines || [])
    .map((rLine) => {
      const qtyBesarPart = roundQty(applyRecipeBufferQty(scaleRecipeIngredientQty(
        recipeQtyForFamily(rLine, 'BESAR'),
        porsiBesarNeeded,
        yieldQty,
        wastePct,
      ), bufferPct));
      const qtyKecilPart = roundQty(applyRecipeBufferQty(scaleRecipeIngredientQty(
        recipeQtyForFamily(rLine, 'KECIL'),
        porsiKecilNeeded,
        yieldQty,
        wastePct,
      ), bufferPct));
      const qty = roundQty(qtyBesarPart + qtyKecilPart);
      return {
        productId: rLine.productId,
        productKode: rLine.productKode,
        productNama: rLine.productNama,
        satuan: rLine.satuan,
        qty,
        qtyBesarPart,
        qtyKecilPart,
      };
    })
    .filter((l) => l.qty > 0);
}
