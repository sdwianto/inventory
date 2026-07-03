import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { processPendingJobs, getJobById, enqueueJob, scheduleJobProcessing, JOB_TYPES } from '@/lib/api/bg-jobs';
import { isWorkerProcessRoute, verifyWorkerOrCronSecret } from '@/lib/api/worker-auth';
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
    const results = await processPendingJobs(db, { limit: 15 });
    return ok({
      processed: results.length,
      results,
      at: new Date().toISOString(),
    });
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
