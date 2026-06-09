// Auth domain handler: login, logout, session profile, seed trigger.

import { NextResponse } from 'next/server';
import { ok, err, cors } from '@/lib/api/db';
import { isHashed, hashPassword, verifyPassword } from '@/lib/api/auth-helpers';
import { ensureDemoUsers, DEMO_USERS } from '@/lib/api/seed';
import {
  SESSION_COOKIE,
  buildSessionPayload,
  createSessionToken,
  sessionCookieOptions,
} from '@/lib/api/session';
import { requireAuth, requireMaster } from '@/lib/api/require-auth';

function attachSessionCookie(response, user) {
  const token = createSessionToken(buildSessionPayload(user));
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}

function clearSessionCookie(response) {
  response.cookies.set(SESSION_COOKIE, '', {
    ...sessionCookieOptions(0),
    maxAge: 0,
  });
  return response;
}

export async function handleAuth({ db, route, method, body, auth }) {
  if (route === '/auth/login' && method === 'POST') {
    const { email, password } = body || {};
    if (!email || !password) return err('Email dan password wajib diisi');
    const isDemoEmail = DEMO_USERS.some((d) => d.email === email);
    let user = await db.collection('users').findOne({ email });
    if (!user && isDemoEmail) {
      await ensureDemoUsers(db);
      user = await db.collection('users').findOne({ email });
    }
    if (!user) return err('Email atau password salah', 401);
    const valid = await verifyPassword(password, user.password);
    if (!valid) return err('Email atau password salah', 401);
    if (!isHashed(user.password)) {
      const newHash = await hashPassword(password);
      await db.collection('users').updateOne({ id: user.id }, { $set: { password: newHash } });
    }
    const profile = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId || 'default',
      tenantName: user.tenantName || user.tenantId || '—',
    };
    const res = cors(NextResponse.json({ user: profile }, { status: 200 }));
    return attachSessionCookie(res, profile);
  }

  if (route === '/auth/logout' && method === 'POST') {
    const res = cors(NextResponse.json({ message: 'logged out' }, { status: 200 }));
    return clearSessionCookie(res);
  }

  if (route === '/auth/me' && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;

    let tenantId = auth.tenantId || 'default';
    let tenantName = auth.tenantName || '';
    const dbUser = auth.userId
      ? await db.collection('users').findOne({ id: auth.userId })
      : null;
    if (dbUser) {
      tenantId = dbUser.tenantId || tenantId;
      tenantName = dbUser.tenantName || tenantName || tenantId;
    }

    const profile = {
      id: auth.userId,
      email: auth.email,
      name: auth.name,
      role: auth.role,
      tenantId,
      tenantName,
    };

    const staleSession = dbUser && (
      tenantId !== auth.tenantId || tenantName !== (auth.tenantName || '')
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
    await ensureDemoUsers(db);
    return ok({ message: 'Akun master diperbarui' });
  }

  return null;
}
