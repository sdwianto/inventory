'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import type { JsonObject } from '@/types/json';

export const HUTANG_QUERY_KEY = ['hutang'];

export function useVendorHutangList(tab = '') {
  const params = new URLSearchParams();
  if (tab) params.set('approvalStatus', tab);
  const q = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: [...HUTANG_QUERY_KEY, 'list', tab],
    queryFn: () => fetchJson<JsonObject[]>(`/api/hutang${q}`),
    select: (data) => (Array.isArray(data) ? data : []),
  });
}

export function useHutangPendingCount(enabled = true) {
  return useQuery({
    queryKey: [...HUTANG_QUERY_KEY, 'pending-count'],
    queryFn: () => fetchJson<{ count?: number }>('/api/hutang/pending-count'),
    select: (d) => d?.count ?? 0,
    staleTime: 30_000,
    enabled,
    refetchInterval: enabled ? 60_000 : false,
  });
}

/** Refresh query hutang saja — tanpa broadcast event (untuk listener cross-page). */
export function useRefreshHutangQueries() {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: HUTANG_QUERY_KEY });
  }, [qc]);
}

/** Mutasi hutang: refresh cache + beri tahu komponen lain (badge sidebar, dll.). */
export function useInvalidateHutang() {
  const refresh = useRefreshHutangQueries();
  return useCallback(() => {
    refresh();
    window.dispatchEvent(new CustomEvent('erp-hutang-change'));
  }, [refresh]);
}
