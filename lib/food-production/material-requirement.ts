/**
 * Material Requirement (MRP) — ADR-001 Sprint 4.
 * Explode Production Plan → Menu → Recipe → ingredients; net vs warehouse stock.
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import type { MenuDoc } from '@/lib/food-production/menu';
import {
  recipeQtyForFamily,
  splitPorsiByKategoriFamily,
  type RecipeDoc,
} from '@/lib/food-production/recipe';
import {
  applyRecipeBufferQty,
  getRecipeBufferPct,
  materialExcludedSet,
  materialOverrideKey,
  materialOverridesMap,
  resolvePlanLineRecipeSlots,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';

export const MATERIAL_REQUIREMENTS_COLLECTION = 'material_requirements';

export type MaterialRequirementStatus = FpDocStatus;

export interface MrpSourceRef {
  menuId?: string;
  menuKode?: string;
  recipeId: string;
  recipeKode?: string;
  qty: number;
}

export interface MaterialRequirementLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  /** Gross requirement in base UOM after yield/waste. */
  qtyGross: number;
  qtyOnHand: number;
  /** max(0, gross - onHand) */
  qtyNet: number;
  shortage: boolean;
  sources: MrpSourceRef[];
}

export interface MaterialRequirementDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  productionPlanId: string;
  productionPlanNo?: string;
  tanggal: string;
  kitchenId: string;
  kitchenNama?: string;
  warehouseKode: string;
  lines: MaterialRequirementLine[];
  status: MaterialRequirementStatus;
  history: DocHistoryEntry[];
  summary: {
    lineCount: number;
    shortageCount: number;
    qtyGrossTotal: number;
    qtyNetTotal: number;
    /** Soft warnings (e.g. menu version drift vs plan snapshot). */
    warnings?: string[];
  };
  /** Snapshot acuan porsi saat explode (audit / rehitungkan). */
  acuanByKategori?: Partial<Record<string, number>> | null;
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

/** Strategi regenerasi MRP setelah acuan/resep berubah. */
export type MrpRegenerateMode = 'recalculate' | 'supersede' | 'create' | 'blocked';

export function decideMrpRegenerateMode(input: {
  existingStatus?: string | null;
  hasBlockingIssue: boolean;
  hasBlockingPr: boolean;
}): { mode: MrpRegenerateMode; error?: string } {
  if (input.hasBlockingIssue) {
    return {
      mode: 'blocked',
      error: 'Ada pengeluaran bahan terkait rencana ini. Batalkan pengeluaran dulu atau koreksi manual.',
    };
  }
  if (input.hasBlockingPr) {
    return {
      mode: 'blocked',
      error: 'Ada permintaan pembelian (PR) aktif terkait MRP ini. Batalkan PR dulu.',
    };
  }
  const s = String(input.existingStatus || '').trim();
  if (!s || s === 'CANCELLED') return { mode: 'create' };
  if (s === 'DRAFT' || s === 'SUBMITTED') return { mode: 'recalculate' };
  if (s === 'APPROVED') return { mode: 'supersede' };
  return {
    mode: 'blocked',
    error: `Status MRP ${s} tidak dapat dihitung ulang`,
  };
}

/** Plan statuses eligible for MRP calculation. */
export const MRP_ELIGIBLE_PLAN_STATUSES = new Set([
  'SUBMITTED',
  'APPROVED',
  'PROCESSING',
  'COMPLETED',
]);

export function isMrpEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

export function roundQty(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Gross ingredient need from one recipe scaled to recipe portions needed.
 * qty = line.qty * (recipePorsiNeeded / yieldQty) * (1 + waste%/100)
 */
export function scaleRecipeIngredientQty(
  lineQty: number,
  recipePorsiNeeded: number,
  yieldQty: number,
  wastePct = 0,
): number {
  const y = Number(yieldQty) > 0 ? Number(yieldQty) : 1;
  const waste = Math.max(0, Number(wastePct) || 0) / 100;
  return lineQty * (recipePorsiNeeded / y) * (1 + waste);
}

export type ExplodeMrpInput = {
  plan: Pick<
    ProductionPlanDoc,
    | 'id'
    | 'noDokumen'
    | 'tanggal'
    | 'kitchenId'
    | 'kitchenNama'
    | 'kitchenWarehouseKode'
    | 'lines'
    | 'status'
    | 'kategoriPorsiList'
    | 'materialOverrides'
    | 'recipeBufferPct'
  >;
  menusById: Map<string, MenuDoc>;
  recipesById: Map<string, RecipeDoc>;
  /** productId → on-hand qty at kitchen warehouse */
  onHandByProduct: Map<string, number>;
  warehouseKode: string;
  /** Optional acuan porsi per kategori (tanggal/dapur) untuk pecah besar vs kecil. */
  acuanByKategori?: Partial<Record<string, number>> | null;
};

export type ExplodeMrpResult =
  | { ok: true; lines: MaterialRequirementLine[]; summary: MaterialRequirementDoc['summary'] }
  | { ok: false; error: string };

/** Pure explosion — unit-tested without Mongo. */
export function explodeMaterialRequirements(input: ExplodeMrpInput): ExplodeMrpResult {
  const { plan, menusById, recipesById, onHandByProduct, warehouseKode, acuanByKategori } = input;
  if (!plan.lines?.length) return { ok: false, error: 'Rencana tidak punya baris resep' };
  if (!warehouseKode) return { ok: false, error: 'Gudang dapur wajib untuk MRP' };

  type Acc = {
    productKode?: string;
    productNama?: string;
    satuan?: string;
    qtyGross: number;
    sources: MrpSourceRef[];
  };
  const acc = new Map<string, Acc>();
  const warnings: string[] = [];
  const overrideQtyByKey = materialOverridesMap(plan.materialOverrides);
  const excludedKeys = materialExcludedSet(plan.materialOverrides);
  if (overrideQtyByKey.size) {
    warnings.push(`${overrideQtyByKey.size} qty kebutuhan diubah manual di rencana`);
  }
  if (excludedKeys.size) {
    warnings.push(`${excludedKeys.size} bahan dicoret (tidak masuk kebutuhan)`);
  }

  for (const planLine of plan.lines) {
    const targetPorsi = Number(planLine.targetPorsi) || 0;
    if (targetPorsi <= 0) {
      return { ok: false, error: 'Target porsi baris rencana tidak valid' };
    }

    if (planLine.menuId && !planLine.recipeId) {
      const menu = menusById.get(planLine.menuId);
      if (
        menu
        && planLine.menuVersion != null
        && menu.version != null
        && Number(planLine.menuVersion) !== Number(menu.version)
      ) {
        warnings.push(
          `Menu ${menu.kode}: rencana memakai v${planLine.menuVersion}, master sekarang v${menu.version}`,
        );
      }
    }

    const resolved = resolvePlanLineRecipeSlots(planLine, menusById);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const kpList = planLine.kategoriPorsiList?.length
      ? planLine.kategoriPorsiList
      : (plan.kategoriPorsiList || []);
    const split = splitPorsiByKategoriFamily(kpList, targetPorsi, acuanByKategori);

    for (const slot of resolved.slots) {
      const recipe = recipesById.get(slot.recipeId);
      if (!recipe) {
        return { ok: false, error: `Resep ${slot.recipeId} tidak ditemukan` };
      }
      if (recipe.aktif === false) {
        return { ok: false, error: `Resep ${recipe.kode || slot.recipeId} nonaktif` };
      }
      if (!recipe.lines?.length) {
        return { ok: false, error: `Resep ${recipe.kode || slot.recipeId} belum punya bahan` };
      }
      const factor = Number(slot.recipeFactor) || 1;
      const porsiBesarNeeded = split.porsiBesar * factor;
      const porsiKecilNeeded = split.porsiKecil * factor;
      const yieldQty = Number(recipe.yieldQty) > 0 ? Number(recipe.yieldQty) : 1;
      const wastePct = Number(recipe.wastePct) || 0;

      for (const rLine of recipe.lines) {
        const qtyBesar = recipeQtyForFamily(rLine, 'BESAR');
        const qtyKecil = recipeQtyForFamily(rLine, 'KECIL');
        const addBesar = scaleRecipeIngredientQty(qtyBesar, porsiBesarNeeded, yieldQty, wastePct);
        const addKecil = scaleRecipeIngredientQty(qtyKecil, porsiKecilNeeded, yieldQty, wastePct);
        const computed = addBesar + addKecil;
        const ovKey = materialOverrideKey(recipe.id, rLine.productId);
        if (excludedKeys.has(ovKey)) continue;
        const bufferPct = getRecipeBufferPct(plan.recipeBufferPct, recipe.id);
        const add = overrideQtyByKey.has(ovKey)
          ? Number(overrideQtyByKey.get(ovKey)) || 0
          : applyRecipeBufferQty(computed, bufferPct);
        if (!(add > 0)) continue;
        const prev = acc.get(rLine.productId) || {
          productKode: rLine.productKode,
          productNama: rLine.productNama,
          satuan: rLine.satuan,
          qtyGross: 0,
          sources: [],
        };
        prev.qtyGross += add;
        prev.productKode = prev.productKode || rLine.productKode;
        prev.productNama = prev.productNama || rLine.productNama;
        prev.satuan = prev.satuan || rLine.satuan;
        prev.sources.push({
          menuId: slot.menuId,
          menuKode: slot.menuKode,
          recipeId: recipe.id,
          recipeKode: recipe.kode,
          qty: roundQty(add),
        });
        acc.set(rLine.productId, prev);
      }
    }
  }

  const lines: MaterialRequirementLine[] = [...acc.entries()]
    .map(([productId, row]) => {
      const qtyGross = roundQty(row.qtyGross);
      const qtyOnHand = roundQty(Number(onHandByProduct.get(productId) || 0));
      const qtyNet = roundQty(Math.max(0, qtyGross - qtyOnHand));
      return {
        productId,
        productKode: row.productKode,
        productNama: row.productNama,
        satuan: row.satuan,
        qtyGross,
        qtyOnHand,
        qtyNet,
        shortage: qtyNet > 0,
        sources: row.sources,
      };
    })
    .sort((a, b) => String(a.productNama || a.productKode || a.productId)
      .localeCompare(String(b.productNama || b.productKode || b.productId), 'id'));

  if (!lines.length) {
    return { ok: false, error: 'Tidak ada bahan yang terhitung dari rencana' };
  }

  const summary = {
    lineCount: lines.length,
    shortageCount: lines.filter((l) => l.shortage).length,
    qtyGrossTotal: roundQty(lines.reduce((s, l) => s + l.qtyGross, 0)),
    qtyNetTotal: roundQty(lines.reduce((s, l) => s + l.qtyNet, 0)),
    ...(warnings.length ? { warnings } : {}),
  };

  return { ok: true, lines, summary };
}

export const MRP_STATUS_LABELS: Record<MaterialRequirementStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Diajukan',
  APPROVED: 'Disetujui',
  PROCESSING: 'Diproses',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};
