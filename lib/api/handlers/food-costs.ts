import type { NextResponse } from 'next/server';
import { ok, err } from '@/lib/api/db';
import { withTenantFilter, resolveOperationalScope } from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import {
  analyzeRecipeStandardCost,
  analyzeMenuStandardCost,
  analyzePlanStandardCost,
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
import {
  loadOperationalReleaseLinesForPlan,
  mergeConsumptionLinesForCost,
} from '@/lib/food-production/material-issue-reconcile';
import {
  MATERIAL_ISSUES_COLLECTION,
  type MaterialIssueDoc,
} from '@/lib/food-production/material-issue';
import {
  PRODUCTION_RESULTS_COLLECTION,
  type ProductionResultDoc,
} from '@/lib/food-production/production-result';
import type { HandlerContext } from '@/types/api/handler';

function asCostRef(p: Record<string, unknown>): ProductCostRef {
  return {
    productId: String(p.id),
    productKode: p.kode != null ? String(p.kode) : undefined,
    productNama: p.nama != null ? String(p.nama) : undefined,
    satuan: p.satuan != null ? String(p.satuan) : undefined,
    hargaBeli: p.hargaBeli != null ? Number(p.hargaBeli) : undefined,
  };
}

async function loadProducts(
  db: HandlerContext['db'],
  scopeAuth: NonNullable<Awaited<ReturnType<typeof resolveOperationalScope>>['scopeAuth']>,
  ids: string[],
) {
  if (!ids.length) return new Map<string, ProductCostRef>();
  const products = await db.collection('products')
    .find(withTenantFilter(scopeAuth, { id: { $in: ids } }))
    .project({ id: 1, kode: 1, nama: 1, satuan: 1, hargaBeli: 1 })
    .toArray();
  return new Map(products.map((p) => [String(p.id), asCostRef(p as Record<string, unknown>)]));
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
      const recipe = await db.collection(RECIPES_COLLECTION).findOne({ ...tenantFilter, id }) as RecipeDoc | null;
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
      const recipes = recipeIds.length
        ? await db.collection(RECIPES_COLLECTION)
          .find({ ...tenantFilter, id: { $in: recipeIds } })
          .toArray() as unknown as RecipeDoc[]
        : [];
      const productIds = recipes.flatMap((r) => (r.lines || []).map((l) => l.productId));
      const standard = analyzePlanStandardCost({
        planId: plan.id,
        planNo: plan.noDokumen,
        planLines: plan.lines || [],
        menusById: new Map(menus.map((m) => [m.id, m])),
        recipesById: new Map(recipes.map((r) => [r.id, r])),
        productsById: await loadProducts(db, scopeAuth, productIds),
      });
      if ('error' in standard) return err(standard.error, 400);
      if (scope === 'plan') return ok(standard);

      const issue = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        { ...tenantFilter, productionPlanId: plan.id, status: 'COMPLETED' },
        { sort: { createdAt: -1 } },
      ) as MaterialIssueDoc | null;
      const result = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
        { ...tenantFilter, productionPlanId: plan.id, status: 'COMPLETED' },
        { sort: { createdAt: -1 } },
      ) as ProductionResultDoc | null;
      const issueProductIds = (issue?.lines || []).map((l) => l.productId);
      const rlLines = await loadOperationalReleaseLinesForPlan(db, scopeAuth, plan.id);
      const mergedLines = mergeConsumptionLinesForCost(issue?.lines || [], rlLines);
      const productsById = await loadProducts(db, scopeAuth, [
        ...new Set([...productIds, ...issueProductIds, ...rlLines.map((l) => l.productId)]),
      ]);
      return ok(analyzeActualCost({
        planId: plan.id,
        planNo: plan.noDokumen,
        issueLines: mergedLines,
        resultLines: result?.lines || [],
        productsById,
        standard: standard.standard,
      }));
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
