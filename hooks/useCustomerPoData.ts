'use client';

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { JsonObject } from '@/types/json';
import { str } from '@/types/json';
import { useQueryClient } from '@/lib/hooks/useApiQuery';
import { useCursorQuery, type CursorPage } from '@/lib/hooks/use-cursor-query';
import { queryKeys } from '@/lib/query-keys';
import { isPendingOptimisticPo } from '@/lib/pembelian-po/helpers';

type InfinitePoData = {
  pages: CursorPage<JsonObject>[];
  pageParams: unknown[];
};

/** Poll singkat saat menunggu sync vendor / konfirmasi SO di sales. */
function needsStatusPoll(items: JsonObject[]): boolean {
  return items.some((p) => {
    if (isPendingOptimisticPo(p)) return false;
    const status = str(p.status);
    if (status === 'SUBMITTED') return true;
    if (status === 'APPROVED' && p.vendorSyncPending !== false) return true;
    return false;
  });
}

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
    {
      limit: 100,
      staleTime: 15_000,
      refetchInterval: (query) => {
        const pages = query.state.data?.pages ?? [];
        const flat = pages.flatMap((p) => (p.items ?? []) as JsonObject[]);
        return needsStatusPoll(flat) ? 5_000 : false;
      },
    },
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
