'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { JsonObject } from '@/types/json';
import { invalidateGrnCaches } from '@/lib/hooks/invalidate-operational';

export const GRN_QUERY_KEY = ['goods-receipts'];

export function useGrnInvoiceStatus(grnId: string | null | undefined, enabled = false) {
  return useQuery({
    queryKey: ['goods-receipts', grnId, 'invoice-status'],
    queryFn: () => fetchJson<{ invoiceSyncStatus?: string }>(`/api/goods-receipts/${grnId}/invoice-status`),
    enabled: !!grnId && enabled,
    refetchInterval: (query) => {
      const s = query.state.data?.invoiceSyncStatus;
      if (s === 'PENDING' || s === 'SYNCING') return 1000;
      return false;
    },
    refetchIntervalInBackground: false,
  });
}

export function useInvalidateGrn() {
  const qc = useQueryClient();
  return () => {
    invalidateGrnCaches(qc, { broadcast: 'grn' });
  };
}
