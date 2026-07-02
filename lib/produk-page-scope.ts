import { getActingTenantId } from '@/lib/acting-tenant-client';
import { getUser } from '@/lib/auth-client';
import { withActingTenantQuery } from '@/lib/tenant-api';
import { queryKeys } from '@/lib/query-keys';

/** Scope key untuk React Query — selaras prefetch menu & halaman produk. */
export function produkPageScopeKey(filterTenantId = '', q = ''): string {
  const user = getUser();
  const acting = user?.role === 'MASTER'
    ? (filterTenantId || getActingTenantId() || '')
    : (filterTenantId || user?.tenantId || 'default');
  return `${acting}:${q}`;
}

export function buildProdukPageUrl(filterTenantId = '', q = '', isMaster?: boolean) {
  const user = getUser();
  const master = isMaster ?? user?.role === 'MASTER';
  let url = `/api/pages/produk?q=${encodeURIComponent(q)}`;
  const tid = filterTenantId || (master ? getActingTenantId() : user?.tenantId || '');
  return withActingTenantQuery(url, tid || '', master);
}

export function produkPageQueryKey(filterTenantId = '', q = '') {
  return queryKeys.pages.produk(produkPageScopeKey(filterTenantId, q));
}
