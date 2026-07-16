/** JWT session — edge-safe (tanpa next/headers / MongoDB). */

import { createHmac, timingSafeEqual } from 'crypto';
import type { AuthContext, SessionPayload } from '@/types/auth';

export const SESSION_COOKIE = 'inventory_session';
export const ACTING_TENANT_COOKIE = 'erp_acting_tenant_id';
const MAX_AGE_SEC = 60 * 60 * 24 * 7;

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  const minLen = process.env.NODE_ENV === 'production' ? 32 : 16;
  if (secret && secret.length >= minLen) return secret;
  if (process.env.NODE_ENV === 'development') {
    return 'dev-only-change-SESSION_SECRET-in-env-local';
  }
  throw new Error(`SESSION_SECRET wajib di-set (min ${minLen} karakter di production)`);
}

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function sign(data: string): Buffer {
  return createHmac('sha256', getSecret()).update(data).digest();
}

export function createSessionToken(payload: Record<string, unknown>): string {
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

export function verifySessionToken(token: string | null | undefined): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const data = `${header}.${body}`;
  const expected = sign(data);
  let actual: Buffer;
  try {
    actual = b64urlDecode(sig);
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** Secure cookies only on HTTPS. HTTP VPS must not set Secure or browser drops the session. */
export function cookieSecureFlag(): boolean {
  const explicit = String(process.env.COOKIE_SECURE || '').trim().toLowerCase();
  if (explicit === '0' || explicit === 'false' || explicit === 'no') return false;
  if (explicit === '1' || explicit === 'true' || explicit === 'yes') return true;
  const publicUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.INVENTORY_PUBLIC_URL ||
    process.env.SALES_PUBLIC_URL ||
    '';
  if (publicUrl.startsWith('http://')) return false;
  if (publicUrl.startsWith('https://')) return true;
  return process.env.NODE_ENV === 'production';
}

export function sessionCookieOptions(maxAgeSec = MAX_AGE_SEC) {
  return {
    httpOnly: true,
    secure: cookieSecureFlag(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSec,
  };
}

export function buildSessionPayload(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId?: string;
  tenantName?: string;
}) {
  return {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId || 'default',
    tenantName: user.tenantName || user.tenantId || '—',
  };
}

export function authFromPayload(payload: SessionPayload | null): AuthContext | null {
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
