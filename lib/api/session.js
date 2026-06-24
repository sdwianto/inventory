// HttpOnly session cookie — signed JWT (HS256) via Node crypto (no extra deps).

import { createHmac, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'inventory_session';
export const ACTING_TENANT_COOKIE = 'erp_acting_tenant_id';
const MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === 'development') {
    return 'dev-only-change-SESSION_SECRET-in-env-local';
  }
  throw new Error('SESSION_SECRET wajib di-set di .env.local (min 16 karakter)');
}

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function sign(data) {
  return createHmac('sha256', getSecret()).update(data).digest();
}

/** @param {object} payload — user session fields */
export function createSessionToken(payload) {
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(
    JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC,
    }),
  );
  const data = `${header}.${body}`;
  const sig = b64urlEncode(sign(data));
  return `${data}.${sig}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const data = `${header}.${body}`;
  const expected = sign(data);
  let actual;
  try {
    actual = b64urlDecode(sig);
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function readSessionCookieFromRequest(request) {
  return request.cookies.get(SESSION_COOKIE)?.value || null;
}

export function readActingTenantFromRequest(request) {
  return request?.cookies?.get(ACTING_TENANT_COOKIE)?.value?.trim() || '';
}

export async function readSessionCookie() {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value || null;
}

export function sessionCookieOptions(maxAgeSec = MAX_AGE_SEC) {
  const secure = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSec,
  };
}

export function buildSessionPayload(user) {
  return {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId || 'default',
    tenantName: user.tenantName || user.tenantId || '—',
  };
}

export function authFromPayload(payload) {
  if (!payload?.sub) return null;
  const role = String(payload.role || '').toUpperCase();
  return {
    userId: payload.sub,
    email: payload.email,
    name: payload.name,
    role,
    tenantId: payload.tenantId || 'default',
    tenantName: payload.tenantName || '',
    isMaster: role === 'MASTER',
  };
}
