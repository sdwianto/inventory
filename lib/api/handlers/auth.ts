// Auth domain handler: login, logout, session profile, seed trigger.

import { NextResponse } from 'next/server';
import type { Db } from 'mongodb';
import { ok, err, cors } from '@/lib/api/db';
import { isHashed, hashPassword } from '@/lib/api/auth-helpers';
import { ensureDemoUsers, getBootstrapUsers } from '@/lib/api/seed';
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
import { findUsersByEmail, resolveLoginUser } from '@/lib/api/user-email';

interface LoginBody {
  email?: string;
  password?: string;
  tenantId?: string;
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
    const { email, password, tenantId } = loginBody;
    if (!email || !password) return err('Email dan password wajib diisi');
    const isDemoEmail = getBootstrapUsers().some(
      (d) => d.email.toLowerCase() === String(email).trim().toLowerCase(),
    );
    let candidates = await findUsersByEmail(db, email);
    if (candidates.length === 0 && isDemoEmail) {
      await ensureDemoUsers(db);
      candidates = await findUsersByEmail(db, email);
    }
    const loginResult = await resolveLoginUser(db, email, password, tenantId);
    if (loginResult.kind === 'pick_tenant') {
      return ok({ needsTenantPick: true, tenants: loginResult.tenants });
    }
    if (loginResult.kind === 'invalid') return err('Email atau password salah', 401);
    if (loginResult.kind !== 'user') return err('Email atau password salah', 401);
    const user = loginResult.user as unknown as DbUserDoc;
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
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_AUTH_SEED !== '1') {
      return err('Endpoint /auth/seed dinonaktifkan di production', 403);
    }
    await ensureDemoUsers(db as Db);
    return ok({ message: 'Akun master diperbarui' });
  }

  return null;
}
