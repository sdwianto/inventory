import type { Db } from 'mongodb';
import { withTenantFilter } from '@/lib/api/tenant-master';
import { planFallbackMrpLines } from '@/lib/api/handlers/material-requirements';
import { loadPlanRecipesForCost } from '@/lib/api/recipe-revisions';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  type MaterialRequirementLine,
} from '@/lib/food-production/material-requirement';
import {
  analyzeMrpStandardCost,
  analyzePlanStandardCost,
  type ProductCostRef,
} from '@/lib/food-production/cost';
import { MENUS_COLLECTION, type MenuDoc } from '@/lib/food-production/menu';
import {
  PRODUCTION_PLANS_COLLECTION,
  collectPlanLineRefs,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import { logger } from '@/lib/api/logger';
import { loadPlanPenerimaPorsi } from '@/lib/api/plan-penerima-porsi';

type ScopeAuth = Parameters<typeof withTenantFilter>[0];

/** Snapshot estimasi biaya bahan per porsi rencana (disimpan di CPO dari RPN). */
export interface PlanCostEstimate {
  productionPlanId: string;
  planNo?: string;
  /** Total biaya bahan ÷ jumlah penerima makan. */
  perPorsi: number;
  totalCost: number;
  penerimaPorsi: number;
  /** Baris bahan tanpa harga beli — estimasi lebih rendah dari seharusnya. */
  missingPriceCount: number;
  lineCount: number;
  /** MRP = baris kebutuhan tersimpan; MRP_LIVE = hitung langsung; RECIPE = resep tanpa MRP. */
  source: 'MRP' | 'MRP_LIVE' | 'RECIPE';
  priceBasis: 'HARGA_BELI';
  computedAt: Date;
}

export async function loadPlanMrpLines(
  db: Db,
  scopeAuth: ScopeAuth,
  plan: ProductionPlanDoc,
): Promise<{ source: 'MRP' | 'MRP_LIVE'; lines: MaterialRequirementLine[] } | null> {
  const mrp = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { productionPlanId: plan.id, status: { $nin: ['CANCELLED'] } }),
    { sort: { createdAt: -1 }, projection: { lines: 1 } },
  ) as { lines?: MaterialRequirementLine[] } | null;
  if (mrp?.lines?.length) return { source: 'MRP', lines: mrp.lines };
  if (mrp) return null;
  const live = await planFallbackMrpLines(db, scopeAuth, plan);
  return live.length ? { source: 'MRP_LIVE', lines: live } : null;
}

/**
 * Harga beli master (harga vendor sesuai tier); produk hasil merge memakai harga produk tujuan.
 * Harga ≤ 0 = belum diisi di master → dihitung sebagai bahan tanpa harga, bukan gratis.
 */
async function loadHargaBeli(db: Db, scopeAuth: ScopeAuth, ids: string[]): Promise<Map<string, ProductCostRef>> {
  if (!ids.length) return new Map();
  const projection = { id: 1, kode: 1, nama: 1, satuan: 1, hargaBeli: 1, mergedInto: 1 };
  const products = await db.collection('products')
    .find(withTenantFilter(scopeAuth, { id: { $in: ids } }))
    .project(projection)
    .toArray();
  const mergedIds = [...new Set(products.map((p) => String(p.mergedInto || '')).filter(Boolean))];
  const targets = mergedIds.length
    ? new Map((await db.collection('products')
      .find(withTenantFilter(scopeAuth, { id: { $in: mergedIds } }))
      .project(projection)
      .toArray()).map((p) => [String(p.id), p]))
    : new Map();
  return new Map(products.map((p) => {
    const target = p.mergedInto ? targets.get(String(p.mergedInto)) : null;
    const harga = Number(target ? target.hargaBeli : p.hargaBeli);
    return [String(p.id), {
      productId: String(p.id),
      productKode: p.kode != null ? String(p.kode) : undefined,
      productNama: p.nama != null ? String(p.nama) : undefined,
      satuan: p.satuan != null ? String(p.satuan) : undefined,
      hargaBeli: Number.isFinite(harga) && harga > 0 ? harga : undefined,
    }];
  }));
}

/**
 * Estimasi biaya bahan per porsi RPN: kebutuhan bruto MRP (semua bahan, termasuk yang sudah ada
 * di stok) × harga beli master, dibagi jumlah penerima makan.
 */
export async function computePlanCostEstimate(
  db: Db,
  scopeAuth: ScopeAuth,
  plan: ProductionPlanDoc,
): Promise<PlanCostEstimate | { error: string }> {
  const penerimaPorsi = await loadPlanPenerimaPorsi(db, scopeAuth, plan);
  if (!(penerimaPorsi > 0)) return { error: 'Rencana belum punya porsi' };

  const mrp = await loadPlanMrpLines(db, scopeAuth, plan);
  if (mrp) {
    const products = await loadHargaBeli(db, scopeAuth, [...new Set(mrp.lines.map((l) => l.productId))]);
    const a = analyzeMrpStandardCost({
      planId: plan.id,
      planNo: plan.noDokumen,
      totalPorsi: penerimaPorsi,
      mrpLines: mrp.lines,
      productsById: products,
    });
    return {
      productionPlanId: plan.id,
      planNo: plan.noDokumen,
      perPorsi: a.standard.perPorsi,
      totalCost: a.standard.totalCost,
      penerimaPorsi,
      missingPriceCount: a.standard.missingPriceCount,
      lineCount: a.lines.length,
      source: mrp.source,
      priceBasis: 'HARGA_BELI',
      computedAt: new Date(),
    };
  }

  const { menuIds, recipeIds: directRecipeIds } = collectPlanLineRefs(plan.lines);
  const menus = menuIds.length
    ? await db.collection(MENUS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { id: { $in: menuIds } }))
      .toArray() as unknown as MenuDoc[]
    : [];
  const recipeIds = [...new Set([
    ...directRecipeIds,
    ...menus.flatMap((m) => (m.items || []).map((i) => i.recipeId)),
  ])];
  const { recipes } = await loadPlanRecipesForCost(db, plan.tenantId, plan.id, recipeIds);
  const products = await loadHargaBeli(db, scopeAuth, [
    ...new Set(recipes.flatMap((r) => (r.lines || []).map((l) => l.productId))),
  ]);
  const a = analyzePlanStandardCost({
    planId: plan.id,
    planNo: plan.noDokumen,
    planLines: plan.lines || [],
    menusById: new Map(menus.map((m) => [m.id, m])),
    recipesById: new Map(recipes.map((r) => [r.id, r])),
    productsById: products,
    penerimaPorsi,
  });
  if ('error' in a) return a;
  return {
    productionPlanId: plan.id,
    planNo: plan.noDokumen,
    perPorsi: a.standard.perPorsi,
    totalCost: a.standard.totalCost,
    penerimaPorsi,
    missingPriceCount: a.standard.missingPriceCount,
    lineCount: a.lines.length,
    source: 'RECIPE',
    priceBasis: 'HARGA_BELI',
    computedAt: new Date(),
  };
}

/** Untuk CPO: gagal hitung tidak boleh menggagalkan pembuatan/pengiriman PO. */
export async function planCostEstimateForCpo(
  db: Db,
  scopeAuth: ScopeAuth,
  productionPlanId: unknown,
): Promise<PlanCostEstimate | null> {
  const id = String(productionPlanId || '').trim();
  if (!id) return null;
  try {
    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as ProductionPlanDoc | null;
    if (!plan) return null;
    const est = await computePlanCostEstimate(db, scopeAuth, plan);
    return 'error' in est ? null : est;
  } catch (e) {
    logger.warn('plan_cost_estimate_failed', { productionPlanId: id, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}
