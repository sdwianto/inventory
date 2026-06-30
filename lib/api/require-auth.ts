// API auth guards — 401 unauthenticated, 403 wrong tenant / role.

import type { NextResponse } from 'next/server';
import type { AuthContext } from '@/types/auth';
import { err } from '@/lib/api/db';

const PUBLIC = [
  { method: 'GET', route: '/' },
  { method: 'GET', route: '/root' },
  { method: 'GET', route: '/health' },
  { method: 'POST', route: '/auth/login' },
  { method: 'POST', route: '/auth/logout' },
  { method: 'POST', route: '/webhooks/sales' },
  { method: 'POST', route: '/integrations/pair' },
];

export function isPublicRoute(method: string, route: string): boolean {
  return PUBLIC.some((p) => p.method === method && p.route === route);
}

export function requireAuth(auth: AuthContext | null | undefined): NextResponse | null {
  if (!auth?.userId) return err('Unauthorized', 401);
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
