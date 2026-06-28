// Filter data per tenant — MASTER lihat semua, role lain hanya tenant session.

import type { AuthContext } from '@/types/auth';
import type { Filter } from 'mongodb';

type TenantDoc = { tenantId?: string | null };

export function normalizeTenantId(tenantId: unknown): string {
  const s = String(tenantId ?? '').trim();
  if (!s || s === 'master') return s || 'default';
  return s.toLowerCase();
}

export function tenantIdMatchFilter(tenantId: unknown): Filter<TenantDoc> {
  const tid = normalizeTenantId(tenantId);
  if (tid === 'default') {
    return {
      $or: [
        { tenantId: 'default' },
        { tenantId: { $exists: false } },
        { tenantId: null },
        { tenantId: '' },
      ],
    };
  }
  const escaped = tid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { tenantId: { $regex: `^${escaped}$`, $options: 'i' } };
}

/** @deprecated Jangan dipakai untuk otorisasi — gunakan ctx.auth + tenantFilterFromAuth */
export function readTenantScope(url: URL) {
  return {
    tenantId: (url.searchParams.get('tenantId') || '').trim(),
    role: (url.searchParams.get('role') || '').trim().toUpperCase(),
  };
}

export function tenantFilterFromAuth(auth: AuthContext | null | undefined): Filter<TenantDoc> {
  if (!auth) return { tenantId: '__denied__' };
  return tenantFilterForQuery(auth.tenantId, auth.role);
}

export function tenantFilterForQuery(
  tenantId: string | undefined,
  role: string | undefined,
): Filter<TenantDoc> {
  if (role === 'MASTER') return {};
  return tenantIdMatchFilter(tenantId);
}

export function mergeTenantScopeFromAuth<T extends Filter<TenantDoc>>(
  baseFilter: T,
  auth: AuthContext | null | undefined,
): Filter<TenantDoc> {
  const tenantPart = tenantFilterFromAuth(auth);
  if (!tenantPart || Object.keys(tenantPart).length === 0) return baseFilter || {};
  if (!baseFilter || Object.keys(baseFilter).length === 0) return tenantPart;
  return { $and: [baseFilter, tenantPart] };
}

/** @deprecated Gunakan mergeTenantScopeFromAuth(auth) */
export function mergeTenantScope<T extends Filter<TenantDoc>>(
  baseFilter: T,
  url: URL,
): Filter<TenantDoc> {
  const { tenantId, role } = readTenantScope(url);
  const tenantPart = tenantFilterForQuery(tenantId, role);
  if (!tenantPart || Object.keys(tenantPart).length === 0) return baseFilter;
  if (!baseFilter || Object.keys(baseFilter).length === 0) return tenantPart;
  return { $and: [baseFilter, tenantPart] };
}

export function canAccessTenantDoc(
  doc: TenantDoc | null | undefined,
  tenantId: string | undefined,
  role: string | undefined,
): boolean {
  if (role === 'MASTER') return true;
  if (!doc) return false;
  const docTid = normalizeTenantId(doc.tenantId || 'default');
  const userTid = normalizeTenantId(tenantId || 'default');
  if (userTid === 'default') {
    return !doc.tenantId || docTid === 'default';
  }
  return docTid === userTid;
}

export function assertDocTenant(
  doc: TenantDoc | null | undefined,
  auth: AuthContext | null | undefined,
): boolean {
  if (!doc) return false;
  return canAccessTenantDoc(doc, auth?.tenantId, auth?.role);
}

export function injectTenantId<T extends Record<string, unknown>>(
  data: T,
  auth: AuthContext | null | undefined,
): T {
  if (!auth) return data;
  if (auth.isMaster) {
    return {
      ...data,
      tenantId: (data.tenantId as string) || auth.tenantId,
      tenantName: (data.tenantName as string) || auth.tenantName,
    };
  }
  return {
    ...data,
    tenantId: auth.tenantId,
    tenantName: auth.tenantName,
  };
}
