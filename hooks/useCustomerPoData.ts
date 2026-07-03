'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { JsonObject } from '@/types/json';
import { useApiQuery, useQueryClient } from '@/lib/hooks/useApiQuery';
import { queryKeys } from '@/lib/query-keys';

export function useCustomerPoList() {
  const queryClient = useQueryClient();
  const query = useApiQuery<JsonObject[]>(
    queryKeys.customerPurchaseOrders.list,
    '/api/customer-purchase-orders',
    { staleTime: 60_000 },
  );

  const setList: Dispatch<SetStateAction<JsonObject[]>> = (updater) => {
    queryClient.setQueryData<JsonObject[]>(queryKeys.customerPurchaseOrders.list, (prev) => {
      const base = Array.isArray(prev) ? prev : [];
      return typeof updater === 'function'
        ? (updater as (p: JsonObject[]) => JsonObject[])(base)
        : updater;
    });
  };

  return {
    list: Array.isArray(query.data) ? query.data : [],
    loading: query.isLoading,
    reload: () => query.refetch(),
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

  return {
    products,
    reloadProducts: () => query.refetch(),
  };
}
