/**
 * Material Requirement (MRP) — ADR-001 Sprint 4.
 * Explode Production Plan → Menu → Recipe → ingredients; net vs warehouse stock.
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import type { MenuDoc } from '@/lib/food-production/menu';
import {
  normalizeRecipeSatuan,
  recipeBaseQtyForFamily,
  recipeUomFamily,
} from '@/lib/food-production/recipe-uom';
import {
  splitPorsiByKategoriFamily,
  type RecipeDoc,
} from '@/lib/food-production/recipe';
import {
  applyRecipeBufferQty,
  getRecipeBufferPct,
  materialExcludedSet,
  materialOverrideKey,
  materialOverrideSatuanMap,
  materialOverridesMap,
  resolvePlanLineRecipeSlots,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';

/** Sisi resep tunggal → kontribusi qty bahan (belum di-round, belum diagregasi ke productId). */
export type RecipeLineContribution = {
  productId: string;
  productKode?: string;
  productNama?: string;
  /** Label satuan basis produk (stok / pengadaan), bukan satuan dapur. */
  satuan?: string;
  qty: number;
};

/**
 * Skala satu resep (besar+kecil, override/exclude/buffer) → kontribusi qty per bahan.
 * Qty dari `qtyBase*` (satuan basis produk); legacy tanpa qtyBase dianggap sudah basis.
 * Pure, unit-tested. Diekstrak (closeout technical debt) dari duplikasi identik antara
 * `explodeMaterialRequirements` (single-plan, strict) dan `buildRencanaKebutuhanLines`
 * (multi-plan, permissive, lib/food-production/rencana-kebutuhan.ts) — kedua fungsi tetap
 * beda kontrol alur (fail-fast vs kumpulkan error, dengan/tanpa cek `recipe.aktif`,
 * rounding per-step vs di akhir) karena beda kebutuhan nyata (dokumen MRP resmi vs preview
 * cetak lintas-plan), bukan sekadar duplikasi kode.
 */
export function computeRecipeLineContributions(input: {
  recipe: { id: string; kode?: string; yieldQty?: number; wastePct?: number; lines?: RecipeDoc['lines'] };
  recipeFactor: number;
  porsiBesar: number;
  porsiKecil: number;
  excludedKeys: Set<string>;
  overrideQtyByKey: Map<string, number>;
  /** Satuan qty override (dapur atau stok). Jika beda dengan resep, override diabaikan. */
  overrideSatuanByKey?: Map<string, string>;
  recipeBufferPct?: Record<string, number>;
}): RecipeLineContribution[] {
  const factor = Number(input.recipeFactor) || 1;
  const porsiBesarNeeded = input.porsiBesar * factor;
  const porsiKecilNeeded = input.porsiKecil * factor;
  const yieldQty = Number(input.recipe.yieldQty) > 0 ? Number(input.recipe.yieldQty) : 1;
  const wastePct = Number(input.recipe.wastePct) || 0;
  const out: RecipeLineContribution[] = [];
  for (const rLine of input.recipe.lines || []) {
    const addBesar = scaleRecipeIngredientQty(
      recipeBaseQtyForFamily(rLine, 'BESAR'),
      porsiBesarNeeded,
      yieldQty,
      wastePct,
    );
    const addKecil = scaleRecipeIngredientQty(
      recipeBaseQtyForFamily(rLine, 'KECIL'),
      porsiKecilNeeded,
      yieldQty,
      wastePct,
    );
    const computed = addBesar + addKecil;
    const ovKey = materialOverrideKey(input.recipe.id, rLine.productId);
    if (input.excludedKeys.has(ovKey)) continue;
    const bufferPct = getRecipeBufferPct(input.recipeBufferPct, input.recipe.id);
    let add: number;
    if (input.overrideQtyByKey.has(ovKey)) {
      const resolved = resolveOverrideToBaseQty({
        qty: Number(input.overrideQtyByKey.get(ovKey)) || 0,
        satuan: input.overrideSatuanByKey?.get(ovKey),
        line: rLine,
      });
      add = resolved == null
        ? applyRecipeBufferQty(computed, bufferPct)
        : resolved;
    } else {
      add = applyRecipeBufferQty(computed, bufferPct);
    }
    if (!(add > 0)) continue;
    out.push({
      productId: rLine.productId,
      productKode: rLine.productKode,
      productNama: rLine.productNama,
      satuan: rLine.baseSatuan || rLine.satuan,
      qty: add,
    });
  }
  return out;
}

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
 * Qty belanja/pengadaan — ceil sesuai resolusi satuan.
 * PCS/GR/ML: bilangan bulat. KG/L: 3 desimal (gram / ml) agar 24 GR tidak jadi 1 KG.
 * Tanpa satuan: tetap ceil integer (kompatibilitas).
 */
export function ceilProcurementQty(n: number, satuan?: string): number {
  const q = Number(n) || 0;
  if (!(q > 0)) return 0;
  const s = normalizeRecipeSatuan(satuan);
  const family = recipeUomFamily(s);
  if (family === 'MASS' && (s === 'KG' || s === 'KILOGRAM')) {
    return Math.ceil(q * 1000 - 1e-9) / 1000;
  }
  if (family === 'VOLUME' && (s === 'L' || s === 'LT' || s === 'LTR' || s === 'LITER')) {
    return Math.ceil(q * 1000 - 1e-9) / 1000;
  }
  return Math.ceil(q - 1e-9);
}

export function procurementQtyStep(satuan?: string): number {
  const s = normalizeRecipeSatuan(satuan);
  const family = recipeUomFamily(s);
  if (family === 'MASS' && (s === 'KG' || s === 'KILOGRAM')) return 0.001;
  if (family === 'VOLUME' && (s === 'L' || s === 'LT' || s === 'LTR' || s === 'LITER')) return 0.001;
  return 1;
}

/**
 * Override qty → satuan basis stok. `null` = override usang (satuan tidak cocok), pakai hitungan resep.
 * - satuan dapur (GR) × factorToBase → KG
 * - satuan stok sama dengan dapur → as-is
 * - override KG sementara resep GR → abaikan (sisa ceil 1 PCS / 1 KG lama)
 */
export function resolveOverrideToBaseQty(input: {
  qty: number;
  satuan?: string | null;
  line: {
    satuan?: string;
    baseSatuan?: string;
    factorToBase?: number;
  };
}): number | null {
  const qty = Number(input.qty);
  if (!Number.isFinite(qty) || qty < 0) return null;
  const ovSat = normalizeRecipeSatuan(input.satuan);
  const kitchen = normalizeRecipeSatuan(input.line.satuan);
  const base = normalizeRecipeSatuan(input.line.baseSatuan);
  const factor = Number(input.line.factorToBase);

  if (!ovSat) return qty;
  if (kitchen && ovSat === kitchen) {
    if (base && kitchen !== base && factor > 0 && Number.isFinite(factor)) {
      return Math.round((qty * factor + Number.EPSILON) * 1e9) / 1e9;
    }
    return qty;
  }
  if (base && ovSat === base) {
    if (kitchen && kitchen !== base) return null;
    return qty;
  }
  return null;
}

/**
 * Gross ingredient need from one recipe scaled to recipe portions needed.
 * qty = qtyBase * (recipePorsiNeeded / yieldQty) * (1 + waste%/100)
 * (qtyBase dari recipeBaseQtyForFamily — satuan basis produk)
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
  const overrideSatuanByKey = materialOverrideSatuanMap(plan.materialOverrides);
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
          productKode: c.productKode,
          productNama: c.productNama,
          satuan: c.satuan,
          qtyGross: 0,
          sources: [],
        };
        prev.qtyGross += c.qty;
        prev.productKode = prev.productKode || c.productKode;
        prev.productNama = prev.productNama || c.productNama;
        prev.satuan = prev.satuan || c.satuan;
        prev.sources.push({
          menuId: slot.menuId,
          menuKode: slot.menuKode,
          recipeId: recipe.id,
          recipeKode: recipe.kode,
          qty: roundQty(c.qty),
        });
        acc.set(c.productId, prev);
      }
    }
  }

  const lines: MaterialRequirementLine[] = [...acc.entries()]
    .map(([productId, row]) => {
      // Gross/net pengadaan = bilangan bulat ke atas (satu kali di agregat produk).
      const qtyGross = ceilProcurementQty(row.qtyGross, row.satuan);
      const qtyOnHand = roundQty(Number(onHandByProduct.get(productId) || 0));
      const qtyNet = ceilProcurementQty(Math.max(0, qtyGross - qtyOnHand), row.satuan);
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
