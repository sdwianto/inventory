// Thin API router — dispatches to domain handlers in /lib/api/handlers/*.

import { NextResponse } from 'next/server';
import type { Db } from 'mongodb';
import { connectToMongo, cors, ok, err } from '@/lib/api/db';
import { logger } from '@/lib/api/logger';
import { captureException } from '@/lib/api/sentry';
import { ensureSeeded } from '@/lib/api/seed';
import { resolveRequestContext } from '@/lib/api/resolve-context';
import { isPublicRoute, requireAuth } from '@/lib/api/require-auth';
import { dispatchRoute } from '@/lib/api/route-dispatch';
import { ensureOperationalIndexes } from '@/lib/api/operational-indexes';
import { publicApiErrorMessage } from '@/lib/api/production-response';
import { enforceDangerousRouteGuard } from '@/lib/api/production-guard';
import { buildHealthResponse } from '@/lib/api/health';
import { checkRateLimit, clientIp, rateLimitResponse } from '@/lib/api/rate-limit';
import { isWorkerRoute, verifyWorkerOrCronSecret } from '@/lib/api/worker-auth';
import {
  isIdempotentMutation,
  readIdempotencyKey,
  replayIdempotentResponse,
  storeIdempotentResponse,
} from '@/lib/api/idempotency';

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 200 }));
}

type RouteContext = { params: Promise<{ path?: string[] }> };

/** Job processor + sync berat — perlu durasi lebih panjang di Vercel Pro. */
export const maxDuration = 60;

async function handleRoute(request: Request, context: RouteContext) {
  const { path = [] } = (await context.params) || {};
  const route = `/${path.join('/')}`;
  const method = request.method;
  const url = new URL(request.url);

  try {
    if ((route === '/' || route === '/root') && method === 'GET') {
      return ok({ message: 'Inventory API ready', status: 'ok' });
    }

    if (route === '/health' && method === 'GET') {
      let db: Db | null = null;
      try {
        db = await connectToMongo();
      } catch {
        db = null;
      }
      const health = await buildHealthResponse(db, 'inventory');
      // HTTP 503 hanya saat DB tidak terjangkau; SLO degraded tetap 200 + body.status.
      const httpStatus = health.checks.database === 'fail' ? 503 : 200;
      return ok(health, httpStatus);
    }

    if (route === '/auth/login' && method === 'POST') {
      const rl = await checkRateLimit(`login:${clientIp(request)}`);
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec);
    }

    const webhookMax = parseInt(process.env.RATE_LIMIT_WEBHOOK_MAX || '120', 10);
    if (route === '/webhooks/sales' && method === 'POST') {
      const rl = await checkRateLimit(`webhook:${clientIp(request)}`, webhookMax);
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec);
    }

    if (route === '/integrations/pair' && method === 'POST') {
      const pairMax = parseInt(process.env.RATE_LIMIT_PAIR_MAX || '10', 10);
      const rl = await checkRateLimit(`pair:${clientIp(request)}`, pairMax);
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec);
    }

    if (route === '/integrations/platform-pair' && method === 'POST') {
      const pairMax = parseInt(process.env.RATE_LIMIT_PAIR_MAX || '10', 10);
      const rl = await checkRateLimit(`platform-pair:${clientIp(request)}`, pairMax);
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec);
    }

    const db = await connectToMongo();
    void ensureOperationalIndexes(db).catch(() => {});

    const isWorker = isWorkerRoute(method, route);
    const workerAuthed = isWorker && verifyWorkerOrCronSecret(request);

    const isPublic = isPublicRoute(method, route);
    if (route === '/auth/login' && method === 'POST') {
      await ensureSeeded(db);
    }

    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      body = await request.json().catch(() => ({}));
    }

    const auth = await resolveRequestContext(request, db);
    if (!isPublic && !workerAuthed) {
      const denied = requireAuth(auth);
      if (denied) return denied;
      const dangerousDenied = enforceDangerousRouteGuard(method, route, auth);
      if (dangerousDenied) return dangerousDenied;
    }

    const ctx = { request, db, route, method, url, path, body, auth };

    const idemKey = readIdempotencyKey(request);
    const tenantId = auth?.tenantId || 'default';
    if (isIdempotentMutation(method, idemKey) && auth && !workerAuthed) {
      const replay = await replayIdempotentResponse(
        db,
        tenantId,
        route,
        method,
        idemKey!,
        body,
      );
      if (replay) return replay;
    }

    const handlerResponse = await dispatchRoute(ctx);

    if (!handlerResponse) {
      return err(`Route ${route} not found`, 404);
    }

    if (isIdempotentMutation(method, idemKey) && auth && !workerAuthed) {
      return storeIdempotentResponse(
        db,
        tenantId,
        route,
        method,
        idemKey!,
        body,
        handlerResponse,
      );
    }

    return handlerResponse;
  } catch (e) {
    logger.error('api_request_failed', {
      route,
      method,
      error: e instanceof Error ? e.message : String(e),
    });
    void captureException(e, { route, method });
    const msg = publicApiErrorMessage(e, 'Terjadi kesalahan server');
    if (msg.includes('MONGO_URL') || msg.includes('Database tidak terjangkau')) {
      return err(
        msg.includes('MONGO_URL') ? msg : 'Database tidak terjangkau. Hubungi administrator.',
        503,
      );
    }
    return err(msg, 500);
  }
}

export const GET = handleRoute;
export const POST = handleRoute;
export const PUT = handleRoute;
export const DELETE = handleRoute;
export const PATCH = handleRoute;
