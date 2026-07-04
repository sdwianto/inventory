import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { processPendingJobs, getJobById, enqueueJob, scheduleJobProcessing, JOB_TYPES, recoverStaleRunningJobs } from '@/lib/api/bg-jobs';
import { isWorkerProcessRoute, verifyWorkerOrCronSecret } from '@/lib/api/worker-auth';
import { requireRole } from '@/lib/api/require-auth';
import { runProcurementRepair } from '@/lib/api/procurement-repair-run';
import type { HandlerContext } from '@/types/api/handler';

function isWorkerReconcileRoute(method: string, route: string): boolean {
  const RECONCILE_ROUTES = new Set([
    '/bg-jobs/enqueue-integration-reconcile',
    '/bg-jobs/enqueue-reconcile', // alias — label pendek di cron-job.org
  ]);
  return RECONCILE_ROUTES.has(route) && (method === 'POST' || method === 'GET');
}

export async function handleBgJobs({
  db,
  route,
  method,
  path,
  auth,
  request,
  url,
}: HandlerContext): Promise<NextResponse | null> {
  if (isWorkerReconcileRoute(method, route)) {
    if (!verifyWorkerOrCronSecret(request)) return err('Unauthorized', 401);
    const { jobId, reused } = await enqueueJob(db, {
      type: JOB_TYPES.INTEGRATION_RECONCILE,
      tenantId: 'system',
      payload: { dedupeKey: 'integration-reconcile:nightly', allTenants: true },
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

  if (isWorkerProcessRoute(method, route)) {
    // Fail closed: hanya worker/cron dengan secret valid — tanpa fallback session.
    if (!verifyWorkerOrCronSecret(request)) return err('Unauthorized', 401);
    const recovered = await recoverStaleRunningJobs(db);
    const results = await processPendingJobs(db, { limit: 15 });
    return ok({
      recoveredStaleRunning: recovered,
      processed: results.length,
      results,
      at: new Date().toISOString(),
    });
  }

  if (route === '/bg-jobs/repair-procurement') {
    if (method === 'GET') {
      return ok({
        message: 'Endpoint perbaikan procurement — gunakan POST (bukan buka langsung di browser).',
        method: 'POST',
        auth: 'Login MASTER/ADMIN/OWNER + cookie session, atau jalankan: npm run repair:procurement -- --apply',
        hint: 'Dari browser DevTools: fetch("/api/bg-jobs/repair-procurement", { method: "POST", credentials: "include" })',
      });
    }
    if (method === 'POST') {
      const deniedRole = requireRole(auth, ['MASTER', 'ADMIN', 'OWNER']);
      if (deniedRole) return deniedRole;
      const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
      if (denied) return denied;
      if (!tenantId) return err('Tenant operasional wajib', 400);
      const result = await runProcurementRepair(db, tenantId);
      return ok({ message: 'Perbaikan procurement selesai', ...result });
    }
    return err('Method not allowed', 405);
  }

  if (path[0] === 'bg-jobs' && path.length === 2 && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const job = await getJobById(db, path[1], tenantId);
    if (!job) return err('Job tidak ditemukan', 404);
    return ok(clean(job));
  }

  return null;
}
