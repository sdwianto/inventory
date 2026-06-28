import type { Db } from 'mongodb';
import type { NextResponse } from 'next/server';
import { ok } from '@/lib/api/db';
import { requireAuth } from '@/lib/api/require-auth';
import { processPendingJobs } from '@/lib/api/bg-jobs';
import type { HandlerContext } from '@/types/api/handler';

export async function handleBgJobs({
  db,
  route,
  method,
  auth,
}: HandlerContext): Promise<NextResponse | null> {
  if (route === '/bg-jobs/process' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const results = await processPendingJobs(db, { limit: 10 });
    return ok({ processed: results.length, results });
  }
  return null;
}
