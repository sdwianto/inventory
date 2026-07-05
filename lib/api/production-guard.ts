/**
 * Production hardening — operasi berbahaya (sandbox, seed, purge tenant).
 * Production: wajib MASTER + env opt-in; operasi destruktif butuh confirm phrase.
 */

import type { NextResponse } from 'next/server';
import type { AuthContext } from '@/types/auth';
import { err } from '@/lib/api/db';
import { TENANT_PURGE_CONFIRM_PHRASE } from '@/lib/dangerous-confirm';

export { TENANT_PURGE_CONFIRM_PHRASE };

export type DangerousRouteKind = 'sandbox' | 'auth_seed' | 'tenant_purge';

export function isProductionHardened(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function classifyDangerousRoute(method: string, route: string): DangerousRouteKind | null {
  if (route.startsWith('/sandbox/')) {
    if (route === '/sandbox/worker-preview' || route === '/sandbox/worker-purge') return null;
    return 'sandbox';
  }
  if (route === '/auth/seed' && method === 'POST') return 'auth_seed';
  if (method === 'DELETE' && /^\/tenants\/[^/]+$/.test(route)) return 'tenant_purge';
  return null;
}

export function getDangerousRouteBlockReason(
  kind: DangerousRouteKind,
  auth: AuthContext | null | undefined,
): string | null {
  if (!isProductionHardened()) return null;
  if (!auth?.userId) return 'Unauthorized';
  if (!auth.isMaster) return 'Forbidden — operasi berbahaya hanya role MASTER di production';

  if (kind === 'auth_seed' && process.env.ALLOW_AUTH_SEED !== '1') {
    return 'Endpoint /auth/seed dinonaktifkan di production (set ALLOW_AUTH_SEED=1 untuk darurat)';
  }
  if (kind === 'sandbox' && process.env.ALLOW_SANDBOX_RESET !== '1') {
    return 'Production: set ALLOW_SANDBOX_RESET=1 untuk reset sandbox';
  }
  return null;
}

export function getDangerousRouteBlock(
  method: string,
  route: string,
  auth: AuthContext | null | undefined,
): { kind: DangerousRouteKind; reason: string } | null {
  const kind = classifyDangerousRoute(method, route);
  if (!kind) return null;
  const reason = getDangerousRouteBlockReason(kind, auth);
  if (!reason) return null;
  return { kind, reason };
}

export function readConfirmPhrase(body: unknown, url?: URL): string {
  const fromBody = body && typeof body === 'object'
    ? String((body as Record<string, unknown>).confirmPhrase ?? '').trim()
    : '';
  const fromQuery = url?.searchParams.get('confirmPhrase')?.trim() || '';
  return fromBody || fromQuery;
}

export function requireProductionConfirmPhrase(
  body: unknown,
  expectedPhrase: string,
  url?: URL,
): string | null {
  if (!isProductionHardened()) return null;
  const phrase = readConfirmPhrase(body, url);
  if (phrase !== expectedPhrase) {
    return `Ketik frasa konfirmasi persis: ${expectedPhrase}`;
  }
  return null;
}

export function auditDangerousRouteAccess(params: {
  route: string;
  method: string;
  kind: DangerousRouteKind;
  allowed: boolean;
  reason?: string;
  auth?: Pick<AuthContext, 'userId' | 'email' | 'role' | 'tenantId' | 'isMaster'> | null;
}): void {
  console.warn(JSON.stringify({
    event: 'dangerous_route_audit',
    app: process.env.APP_CACHE_PREFIX || 'inventory',
    ...params,
    at: new Date().toISOString(),
  }));
}

/** Guard di router — return response 401/403 atau null jika lolos. */
export function enforceDangerousRouteGuard(
  method: string,
  route: string,
  auth: AuthContext | null | undefined,
): NextResponse | null {
  const block = getDangerousRouteBlock(method, route, auth);
  if (!block) return null;
  auditDangerousRouteAccess({
    route,
    method,
    kind: block.kind,
    allowed: false,
    reason: block.reason,
    auth: auth ?? null,
  });
  const status = block.reason === 'Unauthorized' ? 401 : 403;
  return err(block.reason, status);
}
