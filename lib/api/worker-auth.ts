/** Autentikasi worker/cron untuk POST|GET /bg-jobs/process (Vercel Cron pakai GET + Bearer). */

export function isWorkerProcessRoute(method: string, route: string): boolean {
  return route === '/bg-jobs/process' && (method === 'POST' || method === 'GET');
}

export function verifyWorkerOrCronSecret(request: Request): boolean {
  const workerSecret = (process.env.WORKER_SECRET || '').trim();
  const cronSecret = (process.env.CRON_SECRET || '').trim();

  const headerSecret = (request.headers.get('x-worker-secret') || '').trim();
  if (workerSecret && headerSecret === workerSecret) return true;

  const auth = (request.headers.get('authorization') || '').trim();
  let bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  // cron-job.org kadang mengisi token mentah tanpa prefix "Bearer "
  if (!bearer && auth && !auth.includes(' ')) bearer = auth;
  if (!bearer) return false;

  if (cronSecret && bearer === cronSecret) return true;
  if (workerSecret && bearer === workerSecret) return true;
  return false;
}
