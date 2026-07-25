/** MASTER ops dashboard — Inventory + W1-5 reconcile + W1-6 toolkit wrappers. */

import type { NextResponse } from 'next/server';
import type { HandlerContext } from '@/types/api/handler';
import { ok, err, clean } from '@/lib/api/db';
import { requireRole } from '@/lib/api/require-auth';
import { buildHealthResponse } from '@/lib/api/health';
import {
  getFpLatencySnapshots,
  getFpRecentFailures,
  getFpHotpathSlo,
} from '@/lib/api/request-metrics';
import { enqueueJob, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';
import { runProcurementRepair } from '@/lib/api/procurement-repair-run';
import { sweepStuckGrnPosting } from '@/lib/api/stuck-posting-sweep';
import { createIntegrationClient } from '@/lib/integration/client';
import { resolveEffectiveSalesAppUrl } from '@/lib/api/sales-app-url';
import {
  FEFO_RECONCILE_REPORTS_COLLECTION,
  repairFefoBatchMismatches,
  runFefoBatchDetect,
} from '@/lib/api/fefo-batch-reconcile';
import {
  INGREDIENT_LOT_RECONCILE_REPORTS_COLLECTION,
  repairIngredientLotMismatches,
  runIngredientLotDetect,
} from '@/lib/api/ingredient-lot-reconcile';
import {
  ISSUE_FEFO_SHORTFALL_REPORTS_COLLECTION,
  runIssueFefoShortfallDetect,
} from '@/lib/api/issue-fefo-shortfall-reconcile';
import {
  DIST_FEFO_SHORTFALL_REPORTS_COLLECTION,
  runDistFefoShortfallDetect,
} from '@/lib/api/dist-fefo-shortfall-reconcile';
import {
  RELEASE_FEFO_SHORTFALL_REPORTS_COLLECTION,
  runReleaseFefoShortfallDetect,
} from '@/lib/api/release-fefo-shortfall-reconcile';
import {
  DIST_RETURN_FEFO_SHORTFALL_REPORTS_COLLECTION,
  runDistReturnFefoShortfallDetect,
} from '@/lib/api/dist-return-fefo-shortfall-reconcile';
import {
  HSL_WASTE_RECONCILE_REPORTS_COLLECTION,
  runHslWasteDetect,
} from '@/lib/api/hsl-waste-reconcile';
import {
  STOK_BIN_RECONCILE_REPORTS_COLLECTION,
  runStokBinDetect,
} from '@/lib/api/stok-bin-reconcile';

export async function handleOpsDashboard(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, route, method, auth, body } = ctx;

  // W1-5: MASTER triggers Invoice Detect (INTEGRATION_RECONCILE) — Compare/Repair via worker.
  if (route === '/ops/invoice-reconcile/run' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const { jobId, reused } = await enqueueJob(db, {
      type: JOB_TYPES.INTEGRATION_RECONCILE,
      tenantId: 'system',
      payload: {
        dedupeKey: `integration-reconcile:ops:${new Date().toISOString().slice(0, 13)}`,
        allTenants: true,
        source: 'ops-dashboard',
      },
    });
    scheduleJobProcessing(db, { limit: 3 });
    return ok({
      enqueued: true,
      jobId,
      reused,
      type: JOB_TYPES.INTEGRATION_RECONCILE,
      at: new Date().toISOString(),
    });
  }

  // W1-6: Repair — procurement + reconcile for tenant.
  if (route === '/ops/repair' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const payload = (body || {}) as { tenantId?: string };
    const tenantId = String(payload.tenantId || auth?.tenantId || 'default').trim() || 'default';
    const result = await runProcurementRepair(db, tenantId);
    return ok({ ...result, tenantId, at: new Date().toISOString() });
  }

  // W1-6: Sweep stuck GRN POSTING → DRAFT.
  if (route === '/ops/sweep' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const result = await sweepStuckGrnPosting(db);
    return ok({ ...result, at: new Date().toISOString() });
  }

  // W1-6: Ping Sales peer via IntegrationClient (no raw peer fetch).
  if (route === '/ops/ping' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const salesAppUrl = resolveEffectiveSalesAppUrl('');
    if (!salesAppUrl) return err('SALES_APP_URL belum dikonfigurasi', 400);
    const client = createIntegrationClient(db);
    const reachable = await client.pingSalesApp({ salesAppUrl });
    return ok({
      ok: reachable,
      peer: 'sales',
      url: `${salesAppUrl.replace(/\/$/, '')}/api/health`,
      at: new Date().toISOString(),
    });
  }

  // W2-1: FEFO batch Detect.
  if (route === '/ops/fefo-reconcile/run' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const payload = (body || {}) as { tenantId?: string };
    const tenantId = String(payload.tenantId || auth?.tenantId || 'default').trim() || 'default';
    const report = await runFefoBatchDetect(db, tenantId);
    return ok({
      reportId: report.id,
      tenantId: report.tenantId,
      summary: report.summary,
      mismatchSample: report.mismatches.slice(0, 15),
      at: new Date().toISOString(),
    });
  }

  // W2-4: FEFO Repair (past-expiry status + batch-vs-stok excess consume).
  if (route === '/ops/fefo-reconcile/repair' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const payload = (body || {}) as { tenantId?: string };
    const tenantId = String(payload.tenantId || auth?.tenantId || 'default').trim() || 'default';
    const result = await repairFefoBatchMismatches(db, tenantId);
    return ok(result);
  }

  // W2-5: Ingredient lot Detect.
  if (route === '/ops/ingredient-lot-reconcile/run' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const payload = (body || {}) as { tenantId?: string };
    const tenantId = String(payload.tenantId || auth?.tenantId || 'default').trim() || 'default';
    const report = await runIngredientLotDetect(db, tenantId);
    return ok({
      reportId: report.id,
      tenantId: report.tenantId,
      summary: report.summary,
      mismatchSample: report.mismatches.slice(0, 15),
      at: new Date().toISOString(),
    });
  }

  // W2-5: Ingredient lot Repair (ACTIVE past expiry → EXPIRED).
  if (route === '/ops/ingredient-lot-reconcile/repair' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const payload = (body || {}) as { tenantId?: string };
    const tenantId = String(payload.tenantId || auth?.tenantId || 'default').trim() || 'default';
    const result = await repairIngredientLotMismatches(db, tenantId);
    return ok(result);
  }

  // W2-9: Issue FEFO shortfall Detect (W2-6 deferred drift).
  if (route === '/ops/issue-fefo-shortfall/run' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const payload = (body || {}) as { tenantId?: string };
    const tenantId = String(payload.tenantId || auth?.tenantId || 'default').trim() || 'default';
    const report = await runIssueFefoShortfallDetect(db, tenantId);
    return ok({
      reportId: report.id,
      tenantId: report.tenantId,
      summary: report.summary,
      mismatchSample: report.mismatches.slice(0, 15),
      at: new Date().toISOString(),
    });
  }

  // W2-10: Dist FEFO shortfall Detect (W2-2 deferred drift).
  if (route === '/ops/dist-fefo-shortfall/run' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const payload = (body || {}) as { tenantId?: string };
    const tenantId = String(payload.tenantId || auth?.tenantId || 'default').trim() || 'default';
    const report = await runDistFefoShortfallDetect(db, tenantId);
    return ok({
      reportId: report.id,
      tenantId: report.tenantId,
      summary: report.summary,
      mismatchSample: report.mismatches.slice(0, 15),
      at: new Date().toISOString(),
    });
  }

  // W2-11: Release FEFO shortfall Detect (W2-1 deferred drift).
  if (route === '/ops/release-fefo-shortfall/run' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const payload = (body || {}) as { tenantId?: string };
    const tenantId = String(payload.tenantId || auth?.tenantId || 'default').trim() || 'default';
    const report = await runReleaseFefoShortfallDetect(db, tenantId);
    return ok({
      reportId: report.id,
      tenantId: report.tenantId,
      summary: report.summary,
      mismatchSample: report.mismatches.slice(0, 15),
      at: new Date().toISOString(),
    });
  }

  // W2-14: Dist return FEFO restore shortfall Detect (W2-3 deferred drift).
  if (route === '/ops/dist-return-fefo-shortfall/run' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const payload = (body || {}) as { tenantId?: string };
    const tenantId = String(payload.tenantId || auth?.tenantId || 'default').trim() || 'default';
    const report = await runDistReturnFefoShortfallDetect(db, tenantId);
    return ok({
      reportId: report.id,
      tenantId: report.tenantId,
      summary: report.summary,
      mismatchSample: report.mismatches.slice(0, 15),
      at: new Date().toISOString(),
    });
  }

  // W2-15: HSL waste unposted Detect (legacy capture-only waste).
  if (route === '/ops/hsl-waste-reconcile/run' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const payload = (body || {}) as { tenantId?: string };
    const tenantId = String(payload.tenantId || auth?.tenantId || 'default').trim() || 'default';
    const report = await runHslWasteDetect(db, tenantId);
    return ok({
      reportId: report.id,
      tenantId: report.tenantId,
      summary: report.summary,
      mismatchSample: report.mismatches.slice(0, 15),
      at: new Date().toISOString(),
    });
  }

  // W2-17: stok_bin vs stok_lokasi Detect (soft; unslotted often BIN_SUM_LT).
  if (route === '/ops/stok-bin-reconcile/run' && method === 'POST') {
    const denied = requireRole(auth, ['MASTER']);
    if (denied) return denied;
    const payload = (body || {}) as { tenantId?: string };
    const tenantId = String(payload.tenantId || auth?.tenantId || 'default').trim() || 'default';
    const report = await runStokBinDetect(db, tenantId);
    return ok({
      reportId: report.id,
      tenantId: report.tenantId,
      summary: report.summary,
      mismatchSample: report.mismatches.slice(0, 15),
      at: new Date().toISOString(),
    });
  }

  if (route !== '/ops/dashboard' || method !== 'GET') return null;

  const denied = requireRole(auth, ['MASTER']);
  if (denied) return denied;

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [
    health,
    failedWebhooks,
    pendingJobs,
    deadLetterJobs,
    recentAudit,
    fpLatency,
    fpHotpath,
    latestReconcile,
    latestFefo,
    latestIngredientLot,
    latestIssueShortfall,
    latestDistShortfall,
    latestReleaseShortfall,
    latestDistReturnShortfall,
    latestHslWaste,
    latestStokBin,
  ] = await Promise.all([
    buildHealthResponse(db, 'inventory'),
    db.collection('webhook_inbox')
      .find({ status: 'FAILED', createdAt: { $gte: since24h } })
      .sort({ createdAt: -1 })
      .limit(25)
      .project({ id: 1, event: 1, tenantId: 1, status: 1, lastError: 1, createdAt: 1 })
      .toArray(),
    db.collection('bg_jobs')
      .find({ status: 'PENDING' })
      .sort({ createdAt: 1 })
      .limit(20)
      .project({ id: 1, type: 1, tenantId: 1, status: 1, attempts: 1, createdAt: 1, nextRunAt: 1 })
      .toArray(),
    db.collection('bg_jobs')
      .find({ status: 'FAILED', deadLetter: true })
      .sort({ updatedAt: -1 })
      .limit(15)
      .project({ id: 1, type: 1, tenantId: 1, lastError: 1, updatedAt: 1 })
      .toArray(),
    db.collection('audit_log')
      .find({ createdAt: { $gte: since24h } })
      .sort({ createdAt: -1 })
      .limit(15)
      .project({ id: 1, action: 1, summary: 1, tenantId: 1, userName: 1, createdAt: 1 })
      .toArray(),
    getFpLatencySnapshots(),
    getFpHotpathSlo(),
    db.collection('integration_reconcile_reports')
      .find({})
      .sort({ createdAt: -1 })
      .limit(1)
      .project({
        id: 1,
        tenantId: 1,
        createdAt: 1,
        summary: 1,
        'diff.grnInvoiceNotDone': 1,
        'diff.autoFixEnqueued': 1,
      })
      .toArray(),
    db.collection(FEFO_RECONCILE_REPORTS_COLLECTION)
      .find({})
      .sort({ createdAt: -1 })
      .limit(1)
      .project({ id: 1, tenantId: 1, createdAt: 1, summary: 1, mismatches: 1 })
      .toArray(),
    db.collection(INGREDIENT_LOT_RECONCILE_REPORTS_COLLECTION)
      .find({})
      .sort({ createdAt: -1 })
      .limit(1)
      .project({ id: 1, tenantId: 1, createdAt: 1, summary: 1, mismatches: 1 })
      .toArray(),
    db.collection(ISSUE_FEFO_SHORTFALL_REPORTS_COLLECTION)
      .find({})
      .sort({ createdAt: -1 })
      .limit(1)
      .project({ id: 1, tenantId: 1, createdAt: 1, summary: 1, mismatches: 1 })
      .toArray(),
    db.collection(DIST_FEFO_SHORTFALL_REPORTS_COLLECTION)
      .find({})
      .sort({ createdAt: -1 })
      .limit(1)
      .project({ id: 1, tenantId: 1, createdAt: 1, summary: 1, mismatches: 1 })
      .toArray(),
    db.collection(RELEASE_FEFO_SHORTFALL_REPORTS_COLLECTION)
      .find({})
      .sort({ createdAt: -1 })
      .limit(1)
      .project({ id: 1, tenantId: 1, createdAt: 1, summary: 1, mismatches: 1 })
      .toArray(),
    db.collection(DIST_RETURN_FEFO_SHORTFALL_REPORTS_COLLECTION)
      .find({})
      .sort({ createdAt: -1 })
      .limit(1)
      .project({ id: 1, tenantId: 1, createdAt: 1, summary: 1, mismatches: 1 })
      .toArray(),
    db.collection(HSL_WASTE_RECONCILE_REPORTS_COLLECTION)
      .find({})
      .sort({ createdAt: -1 })
      .limit(1)
      .project({ id: 1, tenantId: 1, createdAt: 1, summary: 1, mismatches: 1 })
      .toArray(),
    db.collection(STOK_BIN_RECONCILE_REPORTS_COLLECTION)
      .find({})
      .sort({ createdAt: -1 })
      .limit(1)
      .project({ id: 1, tenantId: 1, createdAt: 1, summary: 1, mismatches: 1 })
      .toArray(),
  ]);

  const report = (latestReconcile[0] || null) as {
    id?: string;
    tenantId?: string;
    createdAt?: Date;
    summary?: Record<string, unknown>;
    diff?: { autoFixEnqueued?: number; grnInvoiceNotDone?: unknown[] };
  } | null;
  const summary = (report?.summary || {}) as Record<string, unknown>;

  const fefoReport = (latestFefo[0] || null) as {
    id?: string;
    tenantId?: string;
    createdAt?: Date;
    summary?: Record<string, unknown>;
    mismatches?: unknown[];
  } | null;
  const fefoSummary = (fefoReport?.summary || {}) as Record<string, unknown>;

  const ingredientLotReport = (latestIngredientLot[0] || null) as {
    id?: string;
    tenantId?: string;
    createdAt?: Date;
    summary?: Record<string, unknown>;
    mismatches?: unknown[];
  } | null;
  const ingredientLotSummary = (ingredientLotReport?.summary || {}) as Record<string, unknown>;

  const issueShortfallReport = (latestIssueShortfall[0] || null) as {
    id?: string;
    tenantId?: string;
    createdAt?: Date;
    summary?: Record<string, unknown>;
    mismatches?: unknown[];
  } | null;
  const issueShortfallSummary = (issueShortfallReport?.summary || {}) as Record<string, unknown>;

  const distShortfallReport = (latestDistShortfall[0] || null) as {
    id?: string;
    tenantId?: string;
    createdAt?: Date;
    summary?: Record<string, unknown>;
    mismatches?: unknown[];
  } | null;
  const distShortfallSummary = (distShortfallReport?.summary || {}) as Record<string, unknown>;

  const releaseShortfallReport = (latestReleaseShortfall[0] || null) as {
    id?: string;
    tenantId?: string;
    createdAt?: Date;
    summary?: Record<string, unknown>;
    mismatches?: unknown[];
  } | null;
  const releaseShortfallSummary = (releaseShortfallReport?.summary || {}) as Record<string, unknown>;

  const distReturnShortfallReport = (latestDistReturnShortfall[0] || null) as {
    id?: string;
    tenantId?: string;
    createdAt?: Date;
    summary?: Record<string, unknown>;
    mismatches?: unknown[];
  } | null;
  const distReturnShortfallSummary = (distReturnShortfallReport?.summary || {}) as Record<string, unknown>;

  const hslWasteReport = (latestHslWaste[0] || null) as {
    id?: string;
    tenantId?: string;
    createdAt?: Date;
    summary?: Record<string, unknown>;
    mismatches?: unknown[];
  } | null;
  const hslWasteSummary = (hslWasteReport?.summary || {}) as Record<string, unknown>;

  const stokBinReport = (latestStokBin[0] || null) as {
    id?: string;
    tenantId?: string;
    createdAt?: Date;
    summary?: Record<string, unknown>;
    mismatches?: unknown[];
  } | null;
  const stokBinSummary = (stokBinReport?.summary || {}) as Record<string, unknown>;

  return ok({
    health,
    failedWebhooks: failedWebhooks.map(clean),
    pendingJobs: pendingJobs.map(clean),
    deadLetterJobs: deadLetterJobs.map(clean),
    recentAudit: recentAudit.map(clean),
    invoiceReconcile: report
      ? {
          reportId: report.id,
          tenantId: report.tenantId,
          createdAt: report.createdAt,
          totalMismatch: Number(summary.totalMismatch || 0),
          grnStale: Number(summary.grnStale || 0),
          grnWithoutDo: Number(summary.grnWithoutDo || 0),
          hutangOrphan: Number(summary.hutangOrphan || 0),
          cpoMismatch: Number(summary.cpoMismatch || 0),
          autoFixEnqueued: Number(
            summary.autoFixEnqueued ?? report.diff?.autoFixEnqueued ?? 0,
          ),
          grnInvoiceNotDoneSample: Array.isArray(report.diff?.grnInvoiceNotDone)
            ? report.diff.grnInvoiceNotDone.slice(0, 10)
            : [],
        }
      : null,
    ingredientLotReconcile: ingredientLotReport
      ? {
          reportId: ingredientLotReport.id,
          tenantId: ingredientLotReport.tenantId,
          createdAt: ingredientLotReport.createdAt,
          totalMismatch: Number(ingredientLotSummary.totalMismatch || 0),
          activePastExpiry: Number(ingredientLotSummary.activePastExpiry || 0),
          expiredWithQty: Number(ingredientLotSummary.expiredWithQty || 0),
          lotVsStok: Number(ingredientLotSummary.lotVsStok || 0),
          mismatchSample: Array.isArray(ingredientLotReport.mismatches)
            ? ingredientLotReport.mismatches.slice(0, 10)
            : [],
        }
      : null,
    fefoReconcile: fefoReport
      ? {
          reportId: fefoReport.id,
          tenantId: fefoReport.tenantId,
          createdAt: fefoReport.createdAt,
          totalMismatch: Number(fefoSummary.totalMismatch || 0),
          expiredWithQty: Number(fefoSummary.expiredWithQty || 0),
          activePastExpiry: Number(fefoSummary.activePastExpiry || 0),
          batchVsStok: Number(fefoSummary.batchVsStok || 0),
          mismatchSample: Array.isArray(fefoReport.mismatches)
            ? fefoReport.mismatches.slice(0, 10)
            : [],
        }
      : null,
    issueFefoShortfall: issueShortfallReport
      ? {
          reportId: issueShortfallReport.id,
          tenantId: issueShortfallReport.tenantId,
          createdAt: issueShortfallReport.createdAt,
          totalMismatch: Number(issueShortfallSummary.totalMismatch || 0),
          issuesWithShortfall: Number(issueShortfallSummary.issuesWithShortfall || 0),
          shortfallQtyTotal: Number(issueShortfallSummary.shortfallQtyTotal || 0),
          mismatchSample: Array.isArray(issueShortfallReport.mismatches)
            ? issueShortfallReport.mismatches.slice(0, 10)
            : [],
        }
      : null,
    distFefoShortfall: distShortfallReport
      ? {
          reportId: distShortfallReport.id,
          tenantId: distShortfallReport.tenantId,
          createdAt: distShortfallReport.createdAt,
          totalMismatch: Number(distShortfallSummary.totalMismatch || 0),
          ordersWithShortfall: Number(distShortfallSummary.ordersWithShortfall || 0),
          shortfallQtyTotal: Number(distShortfallSummary.shortfallQtyTotal || 0),
          mismatchSample: Array.isArray(distShortfallReport.mismatches)
            ? distShortfallReport.mismatches.slice(0, 10)
            : [],
        }
      : null,
    releaseFefoShortfall: releaseShortfallReport
      ? {
          reportId: releaseShortfallReport.id,
          tenantId: releaseShortfallReport.tenantId,
          createdAt: releaseShortfallReport.createdAt,
          totalMismatch: Number(releaseShortfallSummary.totalMismatch || 0),
          releasesWithShortfall: Number(releaseShortfallSummary.releasesWithShortfall || 0),
          shortfallQtyTotal: Number(releaseShortfallSummary.shortfallQtyTotal || 0),
          mismatchSample: Array.isArray(releaseShortfallReport.mismatches)
            ? releaseShortfallReport.mismatches.slice(0, 10)
            : [],
        }
      : null,
    distReturnFefoShortfall: distReturnShortfallReport
      ? {
          reportId: distReturnShortfallReport.id,
          tenantId: distReturnShortfallReport.tenantId,
          createdAt: distReturnShortfallReport.createdAt,
          totalMismatch: Number(distReturnShortfallSummary.totalMismatch || 0),
          ordersWithShortfall: Number(distReturnShortfallSummary.ordersWithShortfall || 0),
          shortfallQtyTotal: Number(distReturnShortfallSummary.shortfallQtyTotal || 0),
          mismatchSample: Array.isArray(distReturnShortfallReport.mismatches)
            ? distReturnShortfallReport.mismatches.slice(0, 10)
            : [],
        }
      : null,
    hslWasteReconcile: hslWasteReport
      ? {
          reportId: hslWasteReport.id,
          tenantId: hslWasteReport.tenantId,
          createdAt: hslWasteReport.createdAt,
          totalMismatch: Number(hslWasteSummary.totalMismatch || 0),
          wasteQtyTotal: Number(hslWasteSummary.wasteQtyTotal || 0),
          mismatchSample: Array.isArray(hslWasteReport.mismatches)
            ? hslWasteReport.mismatches.slice(0, 10)
            : [],
        }
      : null,
    stokBinReconcile: stokBinReport
      ? {
          reportId: stokBinReport.id,
          tenantId: stokBinReport.tenantId,
          createdAt: stokBinReport.createdAt,
          totalMismatch: Number(stokBinSummary.totalMismatch || 0),
          binSumGt: Number(stokBinSummary.binSumGt || 0),
          binSumLt: Number(stokBinSummary.binSumLt || 0),
          mismatchSample: Array.isArray(stokBinReport.mismatches)
            ? stokBinReport.mismatches.slice(0, 10)
            : [],
        }
      : null,
    fpObservability: {
      hotpath: fpHotpath,
      latency: fpLatency,
      recentFailures: getFpRecentFailures(25),
    },
    salesHealthUrl: process.env.SALES_APP_URL
      ? `${String(process.env.SALES_APP_URL).replace(/\/$/, '')}/api/health`
      : null,
  });
}
