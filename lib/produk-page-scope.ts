import { getActingTenantId } from '@/lib/acting-tenant-client';
import { getUser } from '@/lib/auth-client';
import { withActingTenantQuery } from '@/lib/tenant-api';
import { queryKeys } from '@/lib/query-keys';

type ProdukPageFilters = {
  gudangKode?: string;
  itemRole?: string;
};

function catalogFilterKey(filters?: ProdukPageFilters): string {
  return `${filters?.gudangKode || ''}:${filters?.itemRole || ''}`;
}

/** Scope key untuk React Query — selaras prefetch menu & halaman produk. */
export function produkPageScopeKey(filterTenantId = '', q = '', filters?: ProdukPageFilters): string {
  const user = getUser();
  const acting = user?.role === 'MASTER'
    ? (filterTenantId || getActingTenantId() || '')
    : (filterTenantId || user?.tenantId || 'default');
  return `${acting}:${q}:${catalogFilterKey(filters)}`;
}

export function buildProdukPageUrl(
  filterTenantId = '',
  q = '',
  isMaster?: boolean,
  filters?: ProdukPageFilters,
) {
  const user = getUser();
  const master = isMaster ?? user?.role === 'MASTER';
  let url = `/api/pages/produk?q=${encodeURIComponent(q)}`;
  if (filters?.gudangKode) url += `&gudangKode=${encodeURIComponent(filters.gudangKode)}`;
  if (filters?.itemRole) url += `&itemRole=${encodeURIComponent(filters.itemRole)}`;
  const tid = filterTenantId || (master ? getActingTenantId() : user?.tenantId || '');
  return withActingTenantQuery(url, tid || '', master);
}

export function produkPageQueryKey(filterTenantId = '', q = '', filters?: ProdukPageFilters) {
  return queryKeys.pages.produk(produkPageScopeKey(filterTenantId, q, filters));
}
