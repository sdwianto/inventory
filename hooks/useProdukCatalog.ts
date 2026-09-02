import type { JsonObject } from '@/types/json';
import { useCallback, useMemo } from 'react';
import { useCursorQuery } from '@/lib/hooks/use-cursor-query';
import { buildProdukPageUrl, produkPageQueryKey } from '@/lib/produk-page-scope';

export const PRODUCT_PAGE_DEFAULT_LIMIT = 100;

type UseProdukCatalogOptions = {
  filterTenantId: string;
  isMaster?: boolean;
  pageLimit?: number;
  q?: string;
  gudangKode?: string;
  itemRole?: string;
};

export function useProdukCatalog({
  filterTenantId,
  isMaster = false,
  pageLimit = PRODUCT_PAGE_DEFAULT_LIMIT,
  q = '',
  gudangKode = '',
  itemRole = '',
}: UseProdukCatalogOptions) {
  const catalogFilters = useMemo(
    () => ({ gudangKode, itemRole }),
    [gudangKode, itemRole],
  );

  const baseUrl = useMemo(
    () => buildProdukPageUrl(filterTenantId, q, isMaster, catalogFilters),
    [q, filterTenantId, isMaster, catalogFilters],
  );

  const queryKey = useMemo(
    () => produkPageQueryKey(filterTenantId, q, catalogFilters),
    [filterTenantId, q, catalogFilters],
  );

  const enabled = !isMaster || !!filterTenantId;
  const {
    items: products,
    loading,
    hasMore,
    loadMore,
    loadingMore,
    reload,
    error,
  } = useCursorQuery<JsonObject>(queryKey, baseUrl, {
    limit: pageLimit,
    enabled,
    // Stok/harga berubah di luar form (GRN, penyesuaian, fix script) — jangan tahan 60s.
    staleTime: 0,
  });

  const loadProducts = useCallback(async () => {
    await reload();
    return products;
  }, [reload, products]);

  return {
    products,
    loading,
    hasMore,
    loadMore,
    loadingMore,
    error,
    loadProducts,
    reload,
  };
}
