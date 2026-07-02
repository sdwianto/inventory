import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { requireAuth } from '@/lib/api/require-auth';
import { processPendingJobs, getJobById } from '@/lib/api/bg-jobs';
import type { HandlerContext } from '@/types/api/handler';

export async function handleBgJobs({
  db,
  route,
  method,
  path,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (route === '/bg-jobs/process' && method === 'POST') {
    const workerSecret = process.env.WORKER_SECRET || '';
    const headerSecret = request.headers.get('x-worker-secret') || '';
    const workerOk = workerSecret && headerSecret === workerSecret;
    if (!workerOk) {
      const denied = requireAuth(auth);
      if (denied) return denied;
    }
    const results = await processPendingJobs(db, { limit: 10 });
    return ok({ processed: results.length, results });
  }

  if (path[0] === 'bg-jobs' && path.length === 2 && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const job = await getJobById(db, path[1], auth?.tenantId);
    if (!job) return err('Job tidak ditemukan', 404);
    return ok(clean(job));
  }

  return null;
}
