/** Autentikasi worker/cron untuk POST|GET /bg-jobs/process (Vercel Cron pakai GET + Bearer). */

import { secureCompare } from '@/lib/api/secure-compare';

export function isWorkerProcessRoute(method: string, route: string): boolean {
  return route === '/bg-jobs/process' && (method === 'POST' || method === 'GET');
}

const AUDIT_PURGE_ENQUEUE_ROUTES = new Set([
  '/bg-jobs/enqueue-audit-purge',
  '/bg-jobs/enqueue-purge-audit',
]);

const RECONCILE_ENQUEUE_ROUTES = new Set([
  '/bg-jobs/enqueue-integration-reconcile',
  '/bg-jobs/enqueue-reconcile', // alias — label pendek di cron-job.org
]);

export function isWorkerAuditPurgeRoute(method: string, route: string): boolean {
  return AUDIT_PURGE_ENQUEUE_ROUTES.has(route) && (method === 'POST' || method === 'GET');
}

export function isWorkerReconcileRoute(method: string, route: string): boolean {
  return RECONCILE_ENQUEUE_ROUTES.has(route) && (method === 'POST' || method === 'GET');
}

/** Dipanggil inventory → sales.app (SALES_APP_URL + WORKER_SECRET). */
export function isWorkerSandboxRoute(method: string, route: string): boolean {
  return (
    (route === '/sandbox/worker-preview' && method === 'GET') ||
    (route === '/sandbox/worker-purge' && method === 'POST')
  );
}

export function isWorkerRoute(method: string, route: string): boolean {
  return (
    isWorkerProcessRoute(method, route) ||
    isWorkerAuditPurgeRoute(method, route) ||
    isWorkerReconcileRoute(method, route) ||
    isWorkerSandboxRoute(method, route)
  );
}

export function verifyWorkerOrCronSecret(request: Request | undefined): boolean {
  if (!request) return false;
  const workerSecret = (process.env.WORKER_SECRET || '').trim();
  const cronSecret = (process.env.CRON_SECRET || '').trim();

  const headerSecret = (request.headers.get('x-worker-secret') || '').trim();
  if (workerSecret && secureCompare(headerSecret, workerSecret)) return true;

  const auth = (request.headers.get('authorization') || '').trim();
  let bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  // cron-job.org kadang mengisi token mentah tanpa prefix "Bearer "
  if (!bearer && auth && !auth.includes(' ')) bearer = auth;
  // Salin-tempel dari cron-job.org kadang menambah ':' atau spasi di akhir
  bearer = bearer.replace(/[;:,\s]+$/g, '');
  if (!bearer) return false;

  if (cronSecret && secureCompare(bearer, cronSecret)) return true;
  if (workerSecret && secureCompare(bearer, workerSecret)) return true;
  return false;
}
