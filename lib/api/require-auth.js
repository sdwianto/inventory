// API auth guards — 401 unauthenticated, 403 wrong tenant / role.

import { err } from '@/lib/api/db';

const PUBLIC = [
  { method: 'GET', route: '/' },
  { method: 'GET', route: '/root' },
  { method: 'POST', route: '/auth/login' },
  { method: 'POST', route: '/auth/logout' },
  { method: 'POST', route: '/webhooks/sales' },
  { method: 'POST', route: '/integrations/pair' },
];

export function isPublicRoute(method, route) {
  return PUBLIC.some((p) => p.method === method && p.route === route);
}

/** @returns {import('next/server').NextResponse | null} */
export function requireAuth(auth) {
  if (!auth?.userId) return err('Unauthorized', 401);
  return null;
}

/** @returns {import('next/server').NextResponse | null} */
export function requireMaster(auth) {
  const denied = requireAuth(auth);
  if (denied) return denied;
  if (!auth.isMaster) return err('Forbidden', 403);
  return null;
}

/**
 * Non-MASTER may only access their own tenant (legacy `default` includes missing tenantId).
 * @returns {import('next/server').NextResponse | null}
 */
export function requireTenantAccess(auth, targetTenantId) {
  const denied = requireAuth(auth);
  if (denied) return denied;
  if (auth.isMaster) return null;
  const want = (targetTenantId || 'default').trim();
  const have = auth.tenantId || 'default';
  if (have === want) return null;
  if (want === 'default' && have === 'default') return null;
  return err('Forbidden', 403);
}

/** @param {string[]} roles */
export function requireRole(auth, roles) {
  const denied = requireAuth(auth);
  if (denied) return denied;
  if (auth.isMaster) return null;
  const role = auth.role || '';
  if (roles.includes(role)) return null;
  return err('Forbidden — role tidak diizinkan', 403);
}

export const RELEASE_CREATE_ROLES = ['GUDANG', 'ADMIN', 'MASTER'];
export const RELEASE_APPROVE_ROLES = ['SUPERVISOR', 'ADMIN', 'MASTER'];

export const PO_CREATE_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER'];
export const PO_REQUEST_APPROVAL_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER'];
export const PO_APPROVE_ROLES = ['ADMIN', 'MASTER'];
export const PO_DIRECT_SUBMIT_ROLES = ['ADMIN', 'MASTER'];
export const PO_EDIT_ROLES = ['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER'];

/** Penyesuaian stok & edit field stok/minStok pada master produk */
export const STOCK_ADJUST_ROLES = ['SUPERVISOR', 'ADMIN', 'MASTER'];

/** CRUD master produk (bukan sekadar lihat daftar) */
export const PRODUCT_MANAGE_ROLES = ['SUPERVISOR', 'ADMIN', 'MASTER'];
