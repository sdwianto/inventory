// Thin API router — dispatches to domain handlers in /lib/api/handlers/*.

import { NextResponse } from 'next/server';

import { connectToMongo, cors, ok, err } from '@/lib/api/db';
import { ensureSeeded } from '@/lib/api/seed';
import { resolveRequestContext } from '@/lib/api/resolve-context';
import { isPublicRoute, requireAuth } from '@/lib/api/require-auth';
import { handlersForRoute } from '@/lib/api/route-dispatch';

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 200 }));
}

async function handleRoute(request, context) {
  const { path = [] } = (await context.params) || {};
  const route = `/${path.join('/')}`;
  const method = request.method;
  const url = new URL(request.url);

  try {
    // Health check — tanpa MongoDB (respons instan, sama seperti sales.app).
    if ((route === '/' || route === '/root') && method === 'GET') {
      return ok({ message: 'Inventory API ready' });
    }

    const db = await connectToMongo();

    const isPublic = isPublicRoute(method, route);
    if (!isPublic) {
      await ensureSeeded(db);
    } else if (route === '/auth/login' && method === 'POST') {
      await ensureSeeded(db);
    }

    let body = null;
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
    console.error('API Error:', e);
    const msg = e.message || 'Internal server error';
    if (msg.includes('MONGO_URL') || msg.includes('ECONNREFUSED') || msg.includes('connect')) {
      return err(
        msg.includes('MONGO_URL')
          ? msg
          : 'Database tidak terjangkau. Pastikan MongoDB berjalan dan MONGO_URL di .env.local benar.',
        503
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
