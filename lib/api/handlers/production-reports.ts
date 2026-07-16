import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { withTenantFilter, resolveOperationalScope } from '@/lib/api/tenant-master';
import { buildProductionReport, type ProductionReport } from '@/lib/food-production/production-report';
import {
  PRODUCTION_PLANS_COLLECTION,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import {
  MATERIAL_ISSUES_COLLECTION,
  ISSUE_OPEN_STATUSES,
  type MaterialIssueDoc,
} from '@/lib/food-production/material-issue';
import {
  PRODUCTION_RESULTS_COLLECTION,
  RESULT_OPEN_STATUSES,
  type ProductionResultDoc,
} from '@/lib/food-production/production-result';
import type { HandlerContext } from '@/types/api/handler';

function pickIssue(docs: MaterialIssueDoc[]): MaterialIssueDoc | null {
  if (!docs.length) return null;
  const completed = docs.filter((d) => d.status === 'COMPLETED');
  if (completed.length) {
    return completed.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
  }
  return docs.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
}

function pickResult(docs: ProductionResultDoc[]): ProductionResultDoc | null {
  if (!docs.length) return null;
  const completed = docs.filter((d) => d.status === 'COMPLETED');
  if (completed.length) {
    return completed.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
  }
  return docs.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
}

function reportFromDocs(
  plan: ProductionPlanDoc,
  issues: MaterialIssueDoc[],
  results: ProductionResultDoc[],
): ProductionReport {
  const completedIssue = issues.find((i) => i.status === 'COMPLETED') || null;
  const openIssue = issues.find((i) => (ISSUE_OPEN_STATUSES as readonly string[]).includes(i.status)) || null;
  const completedResult = results.find((r) => r.status === 'COMPLETED') || null;
  const openResult = results.find((r) => (RESULT_OPEN_STATUSES as readonly string[]).includes(r.status)) || null;
  const latestIssue = pickIssue(issues);
  const latestResult = pickResult(results);
  const totalTargetPorsi = (plan.lines || []).reduce(
    (s, l) => s + (Number(l.targetPorsi) || 0),
    0,
  );

  return buildProductionReport({
    plan: {
      id: plan.id,
      noDokumen: plan.noDokumen,
      tanggal: plan.tanggal,
      status: plan.status,
      kitchenNama: plan.kitchenNama,
      warehouseKode: plan.kitchenWarehouseKode,
      totalTargetPorsi,
    },
    issue: latestIssue
      ? {
          id: latestIssue.id,
          noDokumen: latestIssue.noDokumen,
          status: latestIssue.status,
          qtyIssuedTotal: latestIssue.summary?.qtyIssuedTotal,
          lineCount: latestIssue.summary?.lineCount ?? latestIssue.lines?.length,
          stockPostedAt: latestIssue.stockPostedAt || null,
        }
      : null,
    result: latestResult
      ? {
          id: latestResult.id,
          noDokumen: latestResult.noDokumen,
          status: latestResult.status,
          targetPorsiTotal: latestResult.summary?.targetPorsiTotal,
          actualPorsiTotal: latestResult.summary?.actualPorsiTotal,
          wastePorsiTotal: latestResult.summary?.wastePorsiTotal,
          lineCount: latestResult.summary?.lineCount ?? latestResult.lines?.length,
          stockPostedAt: latestResult.stockPostedAt || null,
        }
      : null,
    hasCompletedIssue: Boolean(completedIssue),
    hasOpenIssue: Boolean(openIssue),
    hasCompletedResult: Boolean(completedResult),
    hasOpenResult: Boolean(openResult),
  });
}

export async function handleProductionReports(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request } = ctx;

  if (route === '/production-reports' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const tanggal = url.searchParams.get('tanggal');
    const filter: Record<string, unknown> = {
      status: { $in: ['APPROVED', 'PROCESSING', 'COMPLETED'] },
    };
    if (tanggal) filter.tanggal = tanggal;

    const plans = await db.collection(PRODUCTION_PLANS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ tanggal: -1, createdAt: -1 })
      .limit(50)
      .toArray() as unknown as ProductionPlanDoc[];

    if (!plans.length) return ok([]);

    const planIds = plans.map((p) => p.id);
    const [issueRows, resultRows] = await Promise.all([
      db.collection(MATERIAL_ISSUES_COLLECTION)
        .find(withTenantFilter(scopeAuth, { productionPlanId: { $in: planIds } }))
        .toArray(),
      db.collection(PRODUCTION_RESULTS_COLLECTION)
        .find(withTenantFilter(scopeAuth, { productionPlanId: { $in: planIds } }))
        .toArray(),
    ]);
    const issues = issueRows as unknown as MaterialIssueDoc[];
    const results = resultRows as unknown as ProductionResultDoc[];

    const issuesByPlan = new Map<string, MaterialIssueDoc[]>();
    for (const i of issues) {
      const list = issuesByPlan.get(i.productionPlanId) || [];
      list.push(i);
      issuesByPlan.set(i.productionPlanId, list);
    }
    const resultsByPlan = new Map<string, ProductionResultDoc[]>();
    for (const r of results) {
      const list = resultsByPlan.get(r.productionPlanId) || [];
      list.push(r);
      resultsByPlan.set(r.productionPlanId, list);
    }

    const reports = plans.map((plan) => reportFromDocs(
      plan,
      issuesByPlan.get(plan.id) || [],
      resultsByPlan.get(plan.id) || [],
    ));
    return ok(reports.map((r) => clean(r as unknown as Record<string, unknown>)));
  }

  if (path[0] === 'production-reports' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as ProductionPlanDoc | null;
    if (!plan) return err('Rencana produksi tidak ditemukan', 404);

    const [issueRows, resultRows] = await Promise.all([
      db.collection(MATERIAL_ISSUES_COLLECTION)
        .find(withTenantFilter(scopeAuth, { productionPlanId: plan.id }))
        .toArray(),
      db.collection(PRODUCTION_RESULTS_COLLECTION)
        .find(withTenantFilter(scopeAuth, { productionPlanId: plan.id }))
        .toArray(),
    ]);

    return ok(clean(reportFromDocs(
      plan,
      issueRows as unknown as MaterialIssueDoc[],
      resultRows as unknown as ProductionResultDoc[],
    ) as unknown as Record<string, unknown>));
  }

  return null;
}
