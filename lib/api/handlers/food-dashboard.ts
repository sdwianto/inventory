import type { NextResponse } from 'next/server';
import { ok, err } from '@/lib/api/db';
import {
  withTenantFilter,
  resolveOperationalScope,
  tenantIdForWrite,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { buildFoodDashboardSnapshot, type FoodDashboardKpis } from '@/lib/food-production/dashboard';
import { FP_MGMT_READ_ROLES } from '@/lib/food-production/roles';
import { parseHorizon, buildMaterialForecast, type DailyConsumptionPoint } from '@/lib/food-production/forecast';
import { analyzeActualCost, analyzePlanStandardCost, type ProductCostRef } from '@/lib/food-production/cost';
import { PRODUCTION_PLANS_COLLECTION, type ProductionPlanDoc } from '@/lib/food-production/production-plan';
import { MATERIAL_ISSUES_COLLECTION, type MaterialIssueDoc } from '@/lib/food-production/material-issue';
import { PRODUCTION_RESULTS_COLLECTION, type ProductionResultDoc } from '@/lib/food-production/production-result';
import { QC_RESULTS_COLLECTION } from '@/lib/food-production/qc';
import { RECIPES_COLLECTION, type RecipeDoc } from '@/lib/food-production/recipe';
import { MENUS_COLLECTION, type MenuDoc } from '@/lib/food-production/menu';
import { getStokByWarehouseBatch } from '@/lib/api/stok-lokasi';
import type { HandlerContext } from '@/types/api/handler';

const OPEN = ['DRAFT', 'SUBMITTED', 'APPROVED', 'PROCESSING'];

export async function handleFoodDashboard(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, url, request } = ctx;

  if (route === '/food-dashboard' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_MGMT_READ_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const tf = withTenantFilter(scopeAuth, {});
    const [
      openPlans,
      processingPlans,
      openIssues,
      openResults,
      openQc,
      productsMissingNutrition,
      recipes,
    ] = await Promise.all([
      db.collection(PRODUCTION_PLANS_COLLECTION).countDocuments({ ...tf, status: { $in: OPEN } }),
      db.collection(PRODUCTION_PLANS_COLLECTION).countDocuments({ ...tf, status: 'PROCESSING' }),
      db.collection(MATERIAL_ISSUES_COLLECTION).countDocuments({ ...tf, status: { $in: OPEN } }),
      db.collection(PRODUCTION_RESULTS_COLLECTION).countDocuments({ ...tf, status: { $in: OPEN } }),
      db.collection(QC_RESULTS_COLLECTION).countDocuments({ ...tf, status: { $in: OPEN } }),
      db.collection('products').countDocuments({
        ...tf,
        aktif: { $ne: false },
        nutrition: { $exists: false },
      }),
      db.collection(RECIPES_COLLECTION)
        .find({ ...tf, aktif: { $ne: false } })
        .project({ lines: 1 })
        .limit(200)
        .toArray(),
    ]);
    const recipeRows = recipes as unknown as Pick<RecipeDoc, 'lines'>[];

    // Nutrition coverage: % recipes where all ingredient productIds have nutrition
    const allIngredientIds = [...new Set(recipeRows.flatMap((r) => (r.lines || []).map((l) => l.productId)))];
    const withNut = allIngredientIds.length
      ? await db.collection('products')
        .find({ ...tf, id: { $in: allIngredientIds }, nutrition: { $exists: true } })
        .project({ id: 1 })
        .toArray()
      : [];
    const nutSet = new Set(withNut.map((p) => String(p.id)));
    let covered = 0;
    for (const r of recipeRows) {
      const ids = (r.lines || []).map((l) => l.productId);
      if (ids.length && ids.every((id) => nutSet.has(id))) covered += 1;
    }
    const recipesCoveredNutritionPct = recipeRows.length
      ? Math.round((covered / recipeRows.length) * 100)
      : 100;

    // Forecast short count (7d)
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 14);
    const sinceIso = since.toISOString().slice(0, 10);
    const issues = await db.collection(MATERIAL_ISSUES_COLLECTION)
      .find({ ...tf, status: 'COMPLETED', tanggal: { $gte: sinceIso } })
      .project({ tanggal: 1, lines: 1, warehouseKode: 1 })
      .limit(300)
      .toArray() as unknown as MaterialIssueDoc[];
    const points: DailyConsumptionPoint[] = [];
    const pids = new Set<string>();
    const whs = new Set<string>();
    for (const issue of issues) {
      if (issue.warehouseKode) whs.add(issue.warehouseKode);
      for (const line of issue.lines || []) {
        if (!(Number(line.qtyIssued) > 0)) continue;
        pids.add(line.productId);
        points.push({ tanggal: issue.tanggal, productId: line.productId, qty: Number(line.qtyIssued) });
      }
    }
    const tid = tenantIdForWrite(scopeAuth, {});
    const idList = [...pids];
    const stockMap = idList.length ? await getStokByWarehouseBatch(db, tid, idList) : new Map();
    const onHandByProduct = new Map<string, number>();
    for (const pid of idList) {
      const byWh = (stockMap.get(pid) || {}) as Record<string, number>;
      let sum = 0;
      if (whs.size) for (const wh of whs) sum += Number(byWh[wh] || 0);
      else sum = Object.values(byWh).reduce((s, v) => s + Number(v || 0), 0);
      onHandByProduct.set(pid, sum);
    }
    const forecast = buildMaterialForecast({
      horizon: parseHorizon(7),
      points,
      onHandByProduct,
      productMeta: new Map(),
      historyDays: 14,
    });

    // Cost variance alerts: last completed plans with |variance pct| > 15
    const completedPlans = await db.collection(PRODUCTION_PLANS_COLLECTION)
      .find({ ...tf, status: 'COMPLETED' })
      .sort({ updatedAt: -1 })
      .limit(5)
      .toArray() as unknown as ProductionPlanDoc[];
    let costVarianceAlerts = 0;
    for (const plan of completedPlans) {
      const menus = await db.collection(MENUS_COLLECTION)
        .find({ ...tf, id: { $in: (plan.lines || []).map((l) => l.menuId) } })
        .toArray() as unknown as MenuDoc[];
      const recipeIds = menus.flatMap((m) => (m.items || []).map((i) => i.recipeId));
      const recipeDocs = await db.collection(RECIPES_COLLECTION)
        .find({ ...tf, id: { $in: recipeIds } })
        .toArray() as unknown as RecipeDoc[];
      const productIds = recipeDocs.flatMap((r) => (r.lines || []).map((l) => l.productId));
      const products = productIds.length
        ? await db.collection('products')
          .find({ ...tf, id: { $in: productIds } })
          .project({ id: 1, kode: 1, nama: 1, satuan: 1, hargaBeli: 1 })
          .toArray()
        : [];
      const productsById = new Map(products.map((p) => [String(p.id), {
        productId: String(p.id),
        productKode: p.kode != null ? String(p.kode) : undefined,
        productNama: p.nama != null ? String(p.nama) : undefined,
        satuan: p.satuan != null ? String(p.satuan) : undefined,
        hargaBeli: p.hargaBeli != null ? Number(p.hargaBeli) : undefined,
      } as ProductCostRef]));
      const standard = analyzePlanStandardCost({
        planId: plan.id,
        planNo: plan.noDokumen,
        planLines: plan.lines || [],
        menusById: new Map(menus.map((m) => [m.id, m])),
        recipesById: new Map(recipeDocs.map((r) => [r.id, r])),
        productsById,
      });
      if ('error' in standard) continue;
      const issue = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        { ...tf, productionPlanId: plan.id, status: 'COMPLETED' },
        { sort: { createdAt: -1 } },
      ) as MaterialIssueDoc | null;
      const result = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
        { ...tf, productionPlanId: plan.id, status: 'COMPLETED' },
        { sort: { createdAt: -1 } },
      ) as ProductionResultDoc | null;
      if (!issue) continue;
      const actual = analyzeActualCost({
        planId: plan.id,
        issueLines: issue.lines || [],
        resultLines: result?.lines || [],
        productsById,
        standard: standard.standard,
      });
      if (actual.variance && Math.abs(actual.variance.pct) >= 15) costVarianceAlerts += 1;
    }

    const kpis: FoodDashboardKpis = {
      openPlans,
      processingPlans,
      openIssues,
      openResults,
      openQc,
      productsMissingNutrition,
      recipesCoveredNutritionPct,
      forecastShortCount: forecast.summary.shortCount,
      costVarianceAlerts,
    };

    return ok(buildFoodDashboardSnapshot(kpis));
  }

  return null;
}
