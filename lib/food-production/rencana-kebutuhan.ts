/** Build day-level material needs from production plans (client preview / print). */

import type { MenuDoc } from '@/lib/food-production/menu';
import {
  splitPorsiByKategoriFamily,
  recipeQtyForFamily,
  type RecipeDoc,
} from '@/lib/food-production/recipe';
import {
  ceilProcurementQty,
  computeRecipeLineContributions,
  roundQty,
  scaleRecipeIngredientQty,
} from '@/lib/food-production/material-requirement';
import {
  applyRecipeBufferQty,
  materialExcludedSet,
  materialOverrideSatuanMap,
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
  /** Acuan porsi dapur rencana ini — jangan campur dapur filter sidebar. */
  acuanByKategori?: Partial<Record<string, number>> | null;
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
    const overrideSatuanByKey = materialOverrideSatuanMap(plan.materialOverrides);
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
      const acuan = plan.acuanByKategori ?? input.acuanByKategori;
      const split = splitPorsiByKategoriFamily(kpList, targetPorsi, acuan);

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
          overrideSatuanByKey,
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
    .map((line) => ({ ...line, qty: ceilProcurementQty(line.qty, line.satuan) }))
    .filter((line) => line.qty > 0)
    .sort((a, b) =>
      String(a.productNama || a.productKode || a.productId)
        .localeCompare(String(b.productNama || b.productKode || b.productId), 'id'),
    );
  return { lines, errors: [...new Set(errors)] };
}

function fmtNeedQty(n: number): string {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  const rounded = Math.round((x + Number.EPSILON) * 1e6) / 1e6;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded).replace('.', ',');
}

/** `1 PCS × 500 porsi / 500 hasil = 1 PCS` */
export function formatRecipeNeedFormula(input: {
  qtyResep: number;
  satuan?: string;
  porsiRencana: number;
  yieldQty: number;
  qtyHasil: number;
}): string {
  const sat = String(input.satuan || '').trim();
  const satPart = sat ? ` ${sat}` : '';
  const yieldQty = Number(input.yieldQty) > 0 ? Number(input.yieldQty) : 1;
  return `${fmtNeedQty(input.qtyResep)}${satPart} × ${fmtNeedQty(input.porsiRencana)} porsi / ${fmtNeedQty(yieldQty)} hasil = ${fmtNeedQty(input.qtyHasil)}${satPart}`;
}

export function recipeYieldOneWarning(yieldQty: number, porsiRencana: number): string | null {
  const y = Number(yieldQty) > 0 ? Number(yieldQty) : 1;
  const p = Number(porsiRencana) || 0;
  if (y <= 1 && p > 1) {
    return 'Hasil resep 1 porsi — kebutuhan = qty × porsi rencana. Ubah Hasil di master resep jika qty bahan dimaksud untuk satu batch besar.';
  }
  return null;
}

export type RecipeIngredientNeedRow = {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qty: number;
  qtyBesarPart?: number;
  qtyKecilPart?: number;
  qtyResepBesar: number;
  yieldQty: number;
  porsiRencana: number;
  formula: string;
};

/** Qty bahan untuk satu resep pada target porsi (dual besar/kecil), tampil satuan dapur. */
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
}): RecipeIngredientNeedRow[] {
  const menuFactor = Number(input.recipePerMenuPorsi) || 1;
  const bufferPct = Number(input.bufferPct) || 0;
  const porsiRencana = Number(input.menuTargetPorsi) || 0;
  const split = splitPorsiByKategoriFamily(
    input.kategoriPorsiList,
    porsiRencana,
    input.acuanByKategori,
  );
  const porsiBesarNeeded = split.porsiBesar * menuFactor;
  const porsiKecilNeeded = split.porsiKecil * menuFactor;
  const yieldQty = Number(input.recipe.yieldQty) > 0 ? Number(input.recipe.yieldQty) : 1;
  const wastePct = Number(input.recipe.wastePct) || 0;
  return (input.recipe.lines || [])
    .map((rLine) => {
      const kitchenSatuan = rLine.satuan || rLine.baseSatuan;
      const qtyResepBesar = recipeQtyForFamily(rLine, 'BESAR');
      const qtyResepKecil = recipeQtyForFamily(rLine, 'KECIL');
      const qtyBesarPart = roundQty(applyRecipeBufferQty(scaleRecipeIngredientQty(
        qtyResepBesar,
        porsiBesarNeeded,
        yieldQty,
        wastePct,
      ), bufferPct));
      const qtyKecilPart = roundQty(applyRecipeBufferQty(scaleRecipeIngredientQty(
        qtyResepKecil,
        porsiKecilNeeded,
        yieldQty,
        wastePct,
      ), bufferPct));
      const qtyExact = qtyBesarPart + qtyKecilPart;
      const qty = ceilProcurementQty(qtyExact, kitchenSatuan);
      const satPart = String(kitchenSatuan || '').trim();
      let formula: string;
      if (porsiBesarNeeded > 0 && porsiKecilNeeded > 0) {
        formula = `${fmtNeedQty(qtyBesarPart)}${satPart ? ` ${satPart}` : ''} besar + ${fmtNeedQty(qtyKecilPart)}${satPart ? ` ${satPart}` : ''} kecil = ${fmtNeedQty(qtyExact)}${satPart ? ` ${satPart}` : ''}`;
      } else {
        formula = formatRecipeNeedFormula({
          qtyResep: porsiKecilNeeded > 0 ? qtyResepKecil : qtyResepBesar,
          satuan: kitchenSatuan,
          porsiRencana,
          yieldQty,
          qtyHasil: roundQty(qtyExact),
        });
      }
      return {
        productId: rLine.productId,
        productKode: rLine.productKode,
        productNama: rLine.productNama,
        satuan: kitchenSatuan,
        qty,
        qtyBesarPart,
        qtyKecilPart,
        qtyResepBesar,
        yieldQty,
        porsiRencana,
        formula,
      };
    })
    .filter((l) => l.qty > 0);
}
