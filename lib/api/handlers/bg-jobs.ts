import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { processPendingJobs, getJobByIdAccessible, enqueueJob, scheduleJobProcessing, JOB_TYPES, recoverStaleRunningJobs } from '@/lib/api/bg-jobs';
import { shouldUseLegacyBgPoll } from '@/lib/api/execution-wave';
import {
  isWorkerProcessRoute,
  isWorkerAuditPurgeRoute,
  isWorkerReconcileRoute,
  verifyWorkerOrCronSecret,
} from '@/lib/api/worker-auth';
import { requireRole } from '@/lib/api/require-auth';
import { runProcurementRepair } from '@/lib/api/procurement-repair-run';
import { backfillProductGudangForTenant } from '@/lib/api/product-warehouse';
import type { HandlerContext } from '@/types/api/handler';

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

  if (isWorkerAuditPurgeRoute(method, route)) {
    if (!verifyWorkerOrCronSecret(request)) return err('Unauthorized', 401);
    const { jobId, reused } = await enqueueJob(db, {
      type: JOB_TYPES.AUDIT_LOG_PURGE,
      tenantId: 'system',
      payload: { dedupeKey: 'audit-purge:weekly' },
    });
    scheduleJobProcessing(db, { limit: 2 });
    return ok({
      enqueued: true,
      jobId,
      reused,
      type: JOB_TYPES.AUDIT_LOG_PURGE,
      at: new Date().toISOString(),
    });
  }

  if (isWorkerProcessRoute(method, route)) {
    if (!verifyWorkerOrCronSecret(request)) return err('Unauthorized', 401);
    const limitRaw = Number(url.searchParams.get('limit') || 15);
    const limit = Number.isFinite(limitRaw) ? Math.min(30, Math.max(1, limitRaw)) : 15;
    if (!shouldUseLegacyBgPoll()) {
      const { processExecutionJobs } = await import('@/lib/api/process-execution-jobs');
      const execution = await processExecutionJobs(db, {
        limit,
        domain: 'inventory',
        capabilities: ['SYNC', 'CPU_BATCH', 'WEBHOOK'],
      });
      return ok({
        legacyPollDisabled: true,
        processed: execution.processed,
        recovery: execution.recovery,
        execution,
        at: new Date().toISOString(),
      });
    }
    const recovered = await recoverStaleRunningJobs(db);
    const results = await processPendingJobs(db, { limit });
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

  if (route === '/bg-jobs/backfill-product-gudang') {
    if (method === 'GET') {
      return ok({
        message: 'Backfill gudang produk — gunakan POST (MASTER/ADMIN/OWNER).',
        method: 'POST',
        hint: 'fetch("/api/bg-jobs/backfill-product-gudang", { method: "POST", credentials: "include" })',
      });
    }
    if (method === 'POST') {
      const deniedRole = requireRole(auth, ['MASTER', 'ADMIN', 'OWNER']);
      if (deniedRole) return deniedRole;
      const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
      if (denied) return denied;
      if (!tenantId) return err('Tenant operasional wajib', 400);
      const result = await backfillProductGudangForTenant(db, tenantId);
      return ok({ message: 'Backfill gudang produk selesai', tenantId, ...result });
    }
    return err('Method not allowed', 405);
  }

  if (path[0] === 'bg-jobs' && path.length === 3 && path[2] === 'stream' && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const jobId = path[1];
    const { createBgJobStreamResponse } = await import('@/lib/api/bg-job-stream');
    return createBgJobStreamResponse(async () => {
      const job = await getJobByIdAccessible(db, jobId, auth, tenantId);
      return job as Record<string, unknown> | null;
    });
  }

  if (path[0] === 'bg-jobs' && path.length === 2 && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const job = await getJobByIdAccessible(db, path[1], auth, tenantId);
    if (!job) return err('Job tidak ditemukan', 404);
    return ok(clean(job));
  }

  return null;
}
