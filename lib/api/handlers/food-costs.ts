import type { NextResponse } from 'next/server';
import { ok, err } from '@/lib/api/db';
import { withTenantFilter, resolveOperationalScope, tenantIdForWrite } from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { planFallbackMrpLines } from '@/lib/api/handlers/material-requirements';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  type MaterialRequirementLine,
} from '@/lib/food-production/material-requirement';
import {
  analyzeRecipeStandardCost,
  analyzeMenuStandardCost,
  analyzePlanStandardCost,
  analyzeMrpStandardCost,
  analyzeActualCost,
  type ProductCostRef,
} from '@/lib/food-production/cost';
import { FP_MGMT_READ_ROLES } from '@/lib/food-production/roles';
import { RECIPES_COLLECTION, type RecipeDoc } from '@/lib/food-production/recipe';
import { MENUS_COLLECTION, type MenuDoc } from '@/lib/food-production/menu';
import {
  PRODUCTION_PLANS_COLLECTION,
  collectPlanLineRefs,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import { loadPlanActualCostInput } from '@/lib/food-production/actual-consumption';
import {
  PRODUCTION_RESULTS_COLLECTION,
  type ProductionResultDoc,
} from '@/lib/food-production/production-result';
import type { HandlerContext } from '@/types/api/handler';
import { loadPlanRecipesForCost } from '@/lib/api/recipe-revisions';
import {
  RECIPE_REVISIONS_COLLECTION,
  recipeFromRevision,
  type RecipeRevisionDoc,
} from '@/lib/food-production/recipe-revision';

/** costingV2: harga standar = rata-rata bergerak (avgCost), cadangan hargaBeli. */
function asCostRef(p: Record<string, unknown>, useAvgCost: boolean): ProductCostRef {
  const avg = Number(p.avgCost);
  const harga = useAvgCost && Number.isFinite(avg) && avg > 0 ? avg : p.hargaBeli;
  return {
    productId: String(p.id),
    productKode: p.kode != null ? String(p.kode) : undefined,
    productNama: p.nama != null ? String(p.nama) : undefined,
    satuan: p.satuan != null ? String(p.satuan) : undefined,
    hargaBeli: harga != null ? Number(harga) : undefined,
  };
}

async function loadProducts(
  db: HandlerContext['db'],
  scopeAuth: NonNullable<Awaited<ReturnType<typeof resolveOperationalScope>>['scopeAuth']>,
  ids: string[],
) {
  if (!ids.length) return new Map<string, ProductCostRef>();
  const [products, useAvgCost] = await Promise.all([
    db.collection('products')
      .find(withTenantFilter(scopeAuth, { id: { $in: ids } }))
      .project({ id: 1, kode: 1, nama: 1, satuan: 1, hargaBeli: 1, avgCost: 1 })
      .toArray(),
    isTenantFeatureEnabled(db, tenantIdForWrite(scopeAuth, {}), 'costingV2'),
  ]);
  return new Map(products.map((p) => [String(p.id), asCostRef(p as Record<string, unknown>, useAvgCost)]));
}

/** Baris kebutuhan rencana persis seperti MRP: dokumen MRP aktif, atau eksplosi live bila belum ada. */
async function loadPlanMrpLines(
  db: HandlerContext['db'],
  scopeAuth: Parameters<typeof withTenantFilter>[0],
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

export async function handleFoodCosts(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request } = ctx;

  if ((route === '/food-costs/analyze' || (path[0] === 'food-costs' && path[1] === 'analyze')) && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_MGMT_READ_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const scope = String(url.searchParams.get('scope') || '').trim().toLowerCase();
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id) return err('id wajib');
    const tenantFilter = withTenantFilter(scopeAuth, {});

    if (scope === 'recipe') {
      const revisionId = String(url.searchParams.get('revisionId') || '').trim();
      let recipe: RecipeDoc | null;
      if (revisionId) {
        const rev = await db.collection(RECIPE_REVISIONS_COLLECTION).findOne(
          { ...tenantFilter, recipeId: id, id: revisionId },
          { projection: { _id: 0 } },
        ) as RecipeRevisionDoc | null;
        if (!rev) return err('Revisi resep tidak ditemukan', 404);
        recipe = recipeFromRevision(rev);
      } else {
        recipe = await db.collection(RECIPES_COLLECTION).findOne({ ...tenantFilter, id }) as RecipeDoc | null;
      }
      if (!recipe) return err('Resep tidak ditemukan', 404);
      const productsById = await loadProducts(db, scopeAuth, (recipe.lines || []).map((l) => l.productId));
      return ok(analyzeRecipeStandardCost({ recipe, productsById }));
    }

    if (scope === 'menu') {
      const menu = await db.collection(MENUS_COLLECTION).findOne({ ...tenantFilter, id }) as MenuDoc | null;
      if (!menu) return err('Menu tidak ditemukan', 404);
      const recipes = await db.collection(RECIPES_COLLECTION)
        .find({ ...tenantFilter, id: { $in: (menu.items || []).map((i) => i.recipeId) } })
        .toArray() as unknown as RecipeDoc[];
      const productIds = recipes.flatMap((r) => (r.lines || []).map((l) => l.productId));
      const analysis = analyzeMenuStandardCost({
        menu,
        recipesById: new Map(recipes.map((r) => [r.id, r])),
        productsById: await loadProducts(db, scopeAuth, productIds),
      });
      if ('error' in analysis) return err(analysis.error, 400);
      return ok(analysis);
    }

    if (scope === 'plan' || scope === 'actual') {
      const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
        { ...tenantFilter, id },
      ) as ProductionPlanDoc | null;
      if (!plan) return err('Rencana tidak ditemukan', 404);
      const { menuIds, recipeIds: directRecipeIds } = collectPlanLineRefs(plan.lines);
      const menus = menuIds.length
        ? await db.collection(MENUS_COLLECTION)
          .find({ ...tenantFilter, id: { $in: menuIds } })
          .toArray() as unknown as MenuDoc[]
        : [];
      const recipeIds = [...new Set([
        ...directRecipeIds,
        ...menus.flatMap((m) => (m.items || []).map((i) => i.recipeId)),
      ])];
      // Resep dari revisi yang dipin MRP rencana: edit resep sesudahnya tidak mengubah HPP rencana ini.
      const planRecipes = await loadPlanRecipesForCost(db, plan.tenantId, plan.id, recipeIds);
      const { recipes } = planRecipes;
      const recipeRevision = {
        recipeSource: planRecipes.source,
        recipeRevisions: planRecipes.pins,
        ...(planRecipes.mrpNo ? { mrpNo: planRecipes.mrpNo } : {}),
        ...(planRecipes.pinsBackfilled ? { recipeRevisionsBackfilled: true } : {}),
      };
      const mrp = await loadPlanMrpLines(db, scopeAuth, plan);
      const productIds = [...new Set([
        ...recipes.flatMap((r) => (r.lines || []).map((l) => l.productId)),
        ...(mrp?.lines || []).map((l) => l.productId),
      ])];
      const standardProducts = await loadProducts(db, scopeAuth, productIds);
      const standard = mrp
        ? analyzeMrpStandardCost({
          planId: plan.id,
          planNo: plan.noDokumen,
          totalPorsi: (plan.lines || []).reduce((s, l) => s + (Number(l.targetPorsi) || 0), 0),
          mrpLines: mrp.lines,
          productsById: standardProducts,
        })
        : analyzePlanStandardCost({
          planId: plan.id,
          planNo: plan.noDokumen,
          planLines: plan.lines || [],
          menusById: new Map(menus.map((m) => [m.id, m])),
          recipesById: new Map(recipes.map((r) => [r.id, r])),
          productsById: standardProducts,
        });
      if ('error' in standard) return err(standard.error, 400);
      const meta = { ...recipeRevision, standardSource: mrp?.source ?? 'RECIPE' };
      if (scope === 'plan') return ok({ ...standard, ...meta });

      const result = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
        { ...tenantFilter, productionPlanId: plan.id, status: 'COMPLETED' },
        { sort: { createdAt: -1 } },
      ) as ProductionResultDoc | null;
      const actualInput = await loadPlanActualCostInput(db, scopeAuth, plan);
      const productsById = await loadProducts(db, scopeAuth, [
        ...new Set([...productIds, ...actualInput.productIds]),
      ]);
      const actual = analyzeActualCost({
        planId: plan.id,
        planNo: plan.noDokumen,
        issueLines: actualInput.issueLines,
        resultLines: result?.lines || [],
        productsById,
        standard: standard.standard,
        ...(actualInput.kartuCostByProduct ? { kartuCostByProduct: actualInput.kartuCostByProduct } : {}),
      });
      return ok({ ...actual, ...meta });
    }

    return err('scope wajib recipe | menu | plan | actual', 400);
  }

  if ((route === '/food-costs' || path[0] === 'food-costs') && !path[1] && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_MGMT_READ_ROLES]);
    if (deniedRole) return deniedRole;
    // lightweight list: recent plans with standard per porsi
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const plans = await db.collection(PRODUCTION_PLANS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { status: { $in: ['APPROVED', 'PROCESSING', 'COMPLETED'] } }))
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray() as unknown as ProductionPlanDoc[];
    return ok(plans.map((p) => ({
      id: p.id,
      noDokumen: p.noDokumen,
      tanggal: p.tanggal,
      status: p.status,
      kitchenNama: p.kitchenNama,
      totalTargetPorsi: (p.lines || []).reduce((s, l) => s + (Number(l.targetPorsi) || 0), 0),
    })));
  }

  return null;
}
