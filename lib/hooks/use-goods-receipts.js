'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';

export const GRN_QUERY_KEY = ['goods-receipts'];

export function useGoodsReceipts({ refreshProducts = false } = {}) {
  const q = refreshProducts ? '?refreshProducts=1' : '';
  return useQuery({
    queryKey: [...GRN_QUERY_KEY, { refreshProducts }],
    queryFn: () => fetchJson(`/api/goods-receipts${q}`),
    select: (data) => (Array.isArray(data) ? data : []),
  });
}

export function useGrnPendingCount(enabled = true) {
  return useQuery({
    queryKey: ['goods-receipts', 'pending-count'],
    queryFn: () => fetchJson('/api/goods-receipts/pending-count'),
    select: (d) => d?.count ?? 0,
    staleTime: 30_000,
    enabled,
    refetchInterval: enabled ? 60_000 : false,
  });
}

export function useGrnInvoiceStatus(grnId, enabled = false) {
  return useQuery({
    queryKey: ['goods-receipts', grnId, 'invoice-status'],
    queryFn: () => fetchJson(`/api/goods-receipts/${grnId}/invoice-status`),
    enabled: !!grnId && enabled,
    refetchInterval: (query) => {
      const s = query.state.data?.invoiceSyncStatus;
      if (s === 'PENDING' || s === 'SYNCING') return 2000;
      return false;
    },
  });
}

export function useInvalidateGrn() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: GRN_QUERY_KEY });
    qc.invalidateQueries({ queryKey: ['goods-receipts', 'pending-count'] });
    window.dispatchEvent(new CustomEvent('erp-grn-change'));
  };
}
