'use client';

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { JsonObject } from '@/types/json';
import { useApiQuery, useQueryClient } from '@/lib/hooks/useApiQuery';
import { useCursorQuery, type CursorPage } from '@/lib/hooks/use-cursor-query';
import { queryKeys } from '@/lib/query-keys';

type InfinitePoData = {
  pages: CursorPage<JsonObject>[];
  pageParams: unknown[];
};

export function useCustomerPoList() {
  const queryClient = useQueryClient();
  const {
    items,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    reload: reloadCursor,
  } = useCursorQuery<JsonObject>(
    queryKeys.customerPurchaseOrders.list,
    '/api/customer-purchase-orders',
    { limit: 100 },
  );

  // Update optimistis: terapkan updater pada gabungan seluruh halaman,
  // lalu simpan sebagai satu halaman dengan cursor terakhir agar loadMore tetap jalan.
  const setList = useCallback<Dispatch<SetStateAction<JsonObject[]>>>((updater) => {
    queryClient.setQueryData<InfinitePoData>(queryKeys.customerPurchaseOrders.list, (prev) => {
      if (!prev || !Array.isArray(prev.pages)) return prev;
      const flattened = prev.pages.flatMap((p) => p.items ?? []);
      const next = typeof updater === 'function'
        ? (updater as (p: JsonObject[]) => JsonObject[])(flattened)
        : updater;
      const lastPage = prev.pages[prev.pages.length - 1];
      return {
        pageParams: [prev.pageParams?.[0] ?? null],
        pages: [{
          items: next,
          hasMore: lastPage?.hasMore ?? false,
          nextCursor: lastPage?.nextCursor ?? null,
        }],
      };
    });
  }, [queryClient]);

  const reload = useCallback(() => reloadCursor(), [reloadCursor]);

  return {
    list: items,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    reload,
    setList,
  };
}

export function useCustomerPoProducts() {
  const query = useApiQuery<{ items?: JsonObject[] } | JsonObject[]>(
    queryKeys.products.list({ limit: 200, withWarehouseStock: true }),
    '/api/products?limit=200&withWarehouseStock=1',
    { staleTime: 120_000 },
  );

  const products = Array.isArray(query.data)
    ? query.data
    : (query.data?.items || []);

  const reloadProducts = useCallback(() => query.refetch(), [query.refetch]);

  return {
    products,
    reloadProducts,
  };
}
