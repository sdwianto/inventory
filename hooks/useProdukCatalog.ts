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
};

export function useProdukCatalog({
  filterTenantId,
  isMaster = false,
  pageLimit = PRODUCT_PAGE_DEFAULT_LIMIT,
  q = '',
}: UseProdukCatalogOptions) {
  const baseUrl = useMemo(
    () => buildProdukPageUrl(filterTenantId, q, isMaster),
    [q, filterTenantId, isMaster],
  );

  const queryKey = useMemo(
    () => produkPageQueryKey(filterTenantId, q),
    [filterTenantId, q],
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
  } = useCursorQuery<JsonObject>(queryKey, baseUrl, { limit: pageLimit, enabled });

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
