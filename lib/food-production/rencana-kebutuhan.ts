/** Build day-level material needs from production plans (client preview / print). */

import type { MenuDoc } from '@/lib/food-production/menu';
import {
  splitPorsiByKategoriFamily,
  type RecipeDoc,
} from '@/lib/food-production/recipe';
import { recipeBaseQtyForFamily } from '@/lib/food-production/recipe-uom';
import {
  ceilProcurementQty,
  computeRecipeLineContributions,
  roundQty,
  scaleRecipeIngredientQty,
} from '@/lib/food-production/material-requirement';
import {
  applyRecipeBufferQty,
  materialExcludedSet,
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

        const contributions = computeRecipeLineContributions({
          recipe,
          recipeFactor: slot.recipeFactor,
          porsiBesar: split.porsiBesar,
          porsiKecil: split.porsiKecil,
          excludedKeys,
          overrideQtyByKey,
          recipeBufferPct: plan.recipeBufferPct,
        });
        for (const c of contributions) {
          const prev = acc.get(c.productId) || {
            productId: c.productId,
            productKode: c.productKode,
            productNama: c.productNama,
            satuan: c.satuan,
            qty: 0,
            sources: [],
          };
          prev.qty = roundQty(prev.qty + c.qty);
          prev.productKode = prev.productKode || c.productKode;
          prev.productNama = prev.productNama || c.productNama;
          prev.satuan = prev.satuan || c.satuan;
          prev.sources.push({
            planNo: plan.noDokumen,
            kitchenNama: plan.kitchenNama,
            menuKode: slot.menuKode || planLine.menuKode,
            recipeKode: recipe.kode || planLine.recipeKode,
            qty: roundQty(c.qty),
          });
          acc.set(c.productId, prev);
        }
      }
    }
  }

  const lines = [...acc.values()]
    .map((line) => ({ ...line, qty: ceilProcurementQty(line.qty) }))
    .filter((line) => line.qty > 0)
    .sort((a, b) =>
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
        recipeBaseQtyForFamily(rLine, 'BESAR'),
        porsiBesarNeeded,
        yieldQty,
        wastePct,
      ), bufferPct));
      const qtyKecilPart = roundQty(applyRecipeBufferQty(scaleRecipeIngredientQty(
        recipeBaseQtyForFamily(rLine, 'KECIL'),
        porsiKecilNeeded,
        yieldQty,
        wastePct,
      ), bufferPct));
      // Qty input rencana = bilangan bulat ke atas (pengadaan tidak pakai pecahan).
      // Breakdown besar/kecil tetap pecahan untuk transparansi hitungan.
      const qty = ceilProcurementQty(qtyBesarPart + qtyKecilPart);
      return {
        productId: rLine.productId,
        productKode: rLine.productKode,
        productNama: rLine.productNama,
        satuan: rLine.baseSatuan || rLine.satuan,
        qty,
        qtyBesarPart,
        qtyKecilPart,
      };
    })
    .filter((l) => l.qty > 0);
}
