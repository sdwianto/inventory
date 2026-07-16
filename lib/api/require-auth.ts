// API auth guards — 401 unauthenticated, 403 wrong tenant / role.

import type { NextResponse } from 'next/server';
import type { AuthContext } from '@/types/auth';
import { err } from '@/lib/api/db';
import { isPublicRoute } from '@/lib/api/public-routes';

export { isPublicRoute };

export function requireAuth(auth: AuthContext | null | undefined): NextResponse | null {
  if (!auth?.userId) return err('Unauthorized', 401);
  return null;
}

/**
 * Integration API keys may only call scoped public routes (e.g. /api/fp-public/*).
 * Session users are unaffected. Prevents privilege escalation via role:ADMIN on keys.
 */
export function rejectApiKey(auth: AuthContext | null | undefined): NextResponse | null {
  if (auth?.isApiKey) {
    return err('API key hanya untuk endpoint publik bertarget (fp-public)', 403);
  }
  return null;
}

export function requireMaster(auth: AuthContext | null | undefined): NextResponse | null {
  const denied = requireAuth(auth);
  if (denied) return denied;
  if (!auth!.isMaster) return err('Forbidden', 403);
  return null;
}

export function requireTenantAccess(
  auth: AuthContext | null | undefined,
  targetTenantId: string | undefined,
): NextResponse | null {
  const denied = requireAuth(auth);
  if (denied) return denied;
  if (auth!.isMaster) return null;
  const want = (targetTenantId || 'default').trim();
  const have = auth!.tenantId || 'default';
  if (have === want) return null;
  if (want === 'default' && have === 'default') return null;
  return err('Forbidden', 403);
}

export function requireRole(auth: AuthContext | null | undefined, roles: string[]): NextResponse | null {
  const denied = requireAuth(auth);
  if (denied) return denied;
  const keyDenied = rejectApiKey(auth);
  if (keyDenied) return keyDenied;
  if (auth!.isMaster) return null;
  const role = auth!.role || '';
  if (roles.includes(role)) return null;
  if (roles.includes('ADMIN') && role === 'OWNER') return null;
  return err('Forbidden — role tidak diizinkan', 403);
}

export const RELEASE_CREATE_ROLES = ['GUDANG', 'ADMIN', 'MASTER'];
export const RELEASE_APPROVE_ROLES = ['SUPERVISOR', 'ADMIN', 'MASTER'];

export const PO_CREATE_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER'];
export const PO_REQUEST_APPROVAL_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER'];
export const PO_APPROVE_ROLES = ['ADMIN', 'MASTER'];
export const PO_DIRECT_SUBMIT_ROLES = ['ADMIN', 'MASTER'];
export const PO_EDIT_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER'];

export const STOCK_ADJUST_ROLES = ['SUPERVISOR', 'ADMIN', 'MASTER'];
export const PRODUCT_MANAGE_ROLES = ['SUPERVISOR', 'ADMIN', 'MASTER'];
