// Auth domain handler: login, logout, session profile, seed trigger.

import { NextResponse } from 'next/server';
import type { Db } from 'mongodb';
import { ok, err, cors } from '@/lib/api/db';
import { isHashed, hashPassword, verifyPassword } from '@/lib/api/auth-helpers';
import { ensureDemoUsers, DEMO_USERS } from '@/lib/api/seed';
import {
  SESSION_COOKIE,
  ACTING_TENANT_COOKIE,
  buildSessionPayload,
  createSessionToken,
  sessionCookieOptions,
  readActingTenantFromRequest,
} from '@/lib/api/session';
import { requireAuth, requireMaster } from '@/lib/api/require-auth';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import type { HandlerContext } from '@/types/api/handler';
import type { SessionUser } from '@/types/auth';

interface LoginBody {
  email?: string;
  password?: string;
}

interface DbUserDoc {
  id: string;
  email: string;
  name: string;
  role: string;
  password: string;
  tenantId?: string;
  tenantName?: string;
}

function toSessionUser(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId?: string;
  tenantName?: string;
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: normalizeTenantId(user.tenantId || 'default'),
    tenantName: user.tenantName || user.tenantId || '—',
  };
}

function attachSessionCookie(response: NextResponse, user: SessionUser): NextResponse {
  const token = createSessionToken(buildSessionPayload(user));
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}

function clearSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set(SESSION_COOKIE, '', {
    ...sessionCookieOptions(0),
    maxAge: 0,
  });
  return response;
}

export async function handleAuth({
  db,
  route,
  method,
  body,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (route === '/auth/login' && method === 'POST') {
    const loginBody = (body || {}) as LoginBody;
    const { email, password } = loginBody;
    if (!email || !password) return err('Email dan password wajib diisi');
    const isDemoEmail = DEMO_USERS.some((d) => d.email === email);
    let user = await db.collection<DbUserDoc>('users').findOne({ email });
    if (!user && isDemoEmail) {
      await ensureDemoUsers(db);
      user = await db.collection<DbUserDoc>('users').findOne({ email });
    }
    if (!user) return err('Email atau password salah', 401);
    const valid = await verifyPassword(password, user.password);
    if (!valid) return err('Email atau password salah', 401);
    if (!isHashed(user.password)) {
      const newHash = await hashPassword(password);
      await db.collection<DbUserDoc>('users').updateOne({ id: user.id }, { $set: { password: newHash } });
    }
    const profile = toSessionUser(user);
    const res = cors(NextResponse.json({ user: profile }, { status: 200 }));
    return attachSessionCookie(res, profile);
  }

  if (route === '/auth/logout' && method === 'POST') {
    const res = cors(NextResponse.json({ message: 'logged out' }, { status: 200 }));
    clearSessionCookie(res);
    res.cookies.set(ACTING_TENANT_COOKIE, '', { ...sessionCookieOptions(0), maxAge: 0 });
    return res;
  }

  if (route === '/auth/me' && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;

    let tenantId = normalizeTenantId(auth!.tenantId || 'default');
    let tenantName = auth!.tenantName || '';
    const dbUser = auth!.userId
      ? await db.collection<DbUserDoc>('users').findOne({ id: auth!.userId })
      : null;
    if (dbUser) {
      tenantId = normalizeTenantId(dbUser.tenantId || tenantId);
      tenantName = dbUser.tenantName || tenantName || tenantId;
    }

    const profile: SessionUser = {
      id: auth!.userId,
      email: auth!.email,
      name: auth!.name,
      role: auth!.role,
      tenantId,
      tenantName,
    };

    if (auth!.role === 'MASTER') {
      const actingTenantId = readActingTenantFromRequest(request);
      if (actingTenantId) {
        const actingSettings = await db.collection('tenant_settings').findOne({ tenantId: actingTenantId });
        profile.actingTenantId = actingTenantId;
        profile.actingTenantName = (actingSettings?.companyName as string | undefined) || actingTenantId;
      }
    }

    const staleSession = dbUser && (
      tenantId !== auth!.tenantId || tenantName !== (auth!.tenantName || '')
    );
    if (staleSession) {
      const res = cors(NextResponse.json({ user: profile }, { status: 200 }));
      return attachSessionCookie(res, profile);
    }
    return ok({ user: profile });
  }

  if (route === '/auth/seed' && method === 'POST') {
    const denied = requireMaster(auth);
    if (denied) return denied;
    await ensureDemoUsers(db as Db);
    return ok({ message: 'Akun master diperbarui' });
  }

  return null;
}
