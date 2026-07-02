'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { JsonObject } from '@/types/json';
import { NAV_BADGES_QUERY_KEY } from '@/lib/hooks/use-nav-badges';

export const GRN_QUERY_KEY = ['goods-receipts'];

export function useGrnInvoiceStatus(grnId: string | null | undefined, enabled = false) {
  return useQuery({
    queryKey: ['goods-receipts', grnId, 'invoice-status'],
    queryFn: () => fetchJson<{ invoiceSyncStatus?: string }>(`/api/goods-receipts/${grnId}/invoice-status`),
    enabled: !!grnId && enabled,
    refetchInterval: (query) => {
      const s = query.state.data?.invoiceSyncStatus;
      if (s === 'PENDING' || s === 'SYNCING') return 2000;
      return false;
    },
    refetchIntervalInBackground: false,
  });
}

export function useInvalidateGrn() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: GRN_QUERY_KEY });
    qc.invalidateQueries({ queryKey: [...NAV_BADGES_QUERY_KEY] });
    window.dispatchEvent(new CustomEvent('erp-grn-change'));
  };
}
