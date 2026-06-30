// Thin API router — dispatches to domain handlers in /lib/api/handlers/*.

import { NextResponse } from 'next/server';
import type { Db } from 'mongodb';
import { connectToMongo, cors, ok, err } from '@/lib/api/db';
import { logger } from '@/lib/api/logger';
import { ensureSeeded } from '@/lib/api/seed';
import { resolveRequestContext } from '@/lib/api/resolve-context';
import { isPublicRoute, requireAuth } from '@/lib/api/require-auth';
import { handlersForRoute } from '@/lib/api/route-dispatch';
import { publicApiErrorMessage } from '@/lib/api/production-response';
import { buildHealthResponse } from '@/lib/api/health';
import { checkRateLimit, clientIp, rateLimitResponse } from '@/lib/api/rate-limit';

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 200 }));
}

type RouteContext = { params: Promise<{ path?: string[] }> };

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
      return ok(health, health.status === 'ok' ? 200 : 503);
    }

    if (route === '/auth/login' && method === 'POST') {
      const rl = checkRateLimit(`login:${clientIp(request)}`);
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec);
    }

    const webhookMax = parseInt(process.env.RATE_LIMIT_WEBHOOK_MAX || '120', 10);
    if (route === '/webhooks/sales' && method === 'POST') {
      const rl = checkRateLimit(`webhook:${clientIp(request)}`, webhookMax);
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec);
    }

    if (route === '/integrations/pair' && method === 'POST') {
      const pairMax = parseInt(process.env.RATE_LIMIT_PAIR_MAX || '10', 10);
      const rl = checkRateLimit(`pair:${clientIp(request)}`, pairMax);
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterSec);
    }

    const db = await connectToMongo();

    const isPublic = isPublicRoute(method, route);
    if (!isPublic) {
      await ensureSeeded(db);
    } else if (route === '/auth/login' && method === 'POST') {
      await ensureSeeded(db);
    }

    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      body = await request.json().catch(() => ({}));
    }

    const auth = await resolveRequestContext(request, db);
    if (!isPublic) {
      const denied = requireAuth(auth);
      if (denied) return denied;
    }

    const ctx = { request, db, route, method, url, path, body, auth };
    for (const handler of handlersForRoute(route)) {
      const res = await handler(ctx);
      if (res) return res;
    }

    return err(`Route ${route} not found`, 404);
  } catch (e) {
    logger.error('api_request_failed', {
      route,
      method,
      error: e instanceof Error ? e.message : String(e),
    });
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
