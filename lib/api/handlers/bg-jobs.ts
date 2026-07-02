import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { requireAuth } from '@/lib/api/require-auth';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { processPendingJobs, getJobById } from '@/lib/api/bg-jobs';
import { isWorkerProcessRoute, verifyWorkerOrCronSecret } from '@/lib/api/worker-auth';
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
  if (isWorkerProcessRoute(method, route)) {
    const workerOk = verifyWorkerOrCronSecret(request);
    if (!workerOk) {
      const denied = requireAuth(auth);
      if (denied) return denied;
    }
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
