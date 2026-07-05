/**
 * Edge-injected session headers (ditandatangani proxy) — hindari re-parse JWT di API handler.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { authFromPayload } from '@/lib/api/session-token';
import type { AuthContext, SessionPayload } from '@/types/auth';

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  const minLen = process.env.NODE_ENV === 'production' ? 32 : 16;
  if (secret && secret.length >= minLen) return secret;
  if (process.env.NODE_ENV === 'development') {
    return 'dev-only-change-SESSION_SECRET-in-env-local';
  }
  throw new Error(`SESSION_SECRET wajib di-set (min ${minLen} karakter di production)`);
}

function signPayload(payload: SessionPayload): string {
  const exp = payload.exp || 0;
  const data = `${payload.sub}|${payload.tenantId || 'default'}|${payload.role || ''}|${exp}`;
  return createHmac('sha256', getSecret()).update(data).digest('hex');
}

export function buildEdgeSessionHeaders(payload: SessionPayload): Record<string, string> {
  return {
    'x-erp-user-id': String(payload.sub),
    'x-erp-tenant-id': String(payload.tenantId || 'default'),
    'x-erp-role': String(payload.role || ''),
    'x-erp-email': String(payload.email || ''),
    'x-erp-name': String(payload.name || ''),
    'x-erp-tenant-name': String(payload.tenantName || ''),
    'x-erp-session-exp': String(payload.exp || 0),
    'x-erp-session-sig': signPayload(payload),
  };
}

export function authFromEdgeHeaders(request: Request): AuthContext | null {
  const userId = request.headers.get('x-erp-user-id');
  const sig = request.headers.get('x-erp-session-sig');
  const expRaw = request.headers.get('x-erp-session-exp');
  if (!userId || !sig || !expRaw) return null;

  const exp = parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;

  const payload: SessionPayload = {
    sub: userId,
    tenantId: request.headers.get('x-erp-tenant-id') || 'default',
    role: request.headers.get('x-erp-role') || '',
    email: request.headers.get('x-erp-email') || '',
    name: request.headers.get('x-erp-name') || '',
    tenantName: request.headers.get('x-erp-tenant-name') || '',
    exp,
  };

  const expected = signPayload(payload);
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  return authFromPayload(payload);
}
