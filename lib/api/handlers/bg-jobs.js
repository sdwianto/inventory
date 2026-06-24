import { ok, err } from '@/lib/api/db';
import { requireAuth } from '@/lib/api/require-auth';
import { processPendingJobs } from '@/lib/api/bg-jobs';

export async function handleBgJobs({ db, route, method, auth }) {
  if (route === '/bg-jobs/process' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const results = await processPendingJobs(db, { limit: 10 });
    return ok({ processed: results.length, results });
  }
  return null;
}
