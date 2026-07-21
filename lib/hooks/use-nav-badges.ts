'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import { getActingTenantId } from '@/lib/acting-tenant-client';
import { getUser } from '@/lib/auth-client';

export const NAV_BADGES_QUERY_KEY = ['nav-badges'] as const;

export type NavBadgeBroadcast = 'grn' | 'hutang' | 'maintenance';

/** Invalidate badge sidebar; opsional broadcast untuk refresh halaman terkait. */
export function invalidateNavBadges(
  qc: QueryClient,
  opts?: { broadcast?: NavBadgeBroadcast },
) {
  void qc.invalidateQueries({ queryKey: [...NAV_BADGES_QUERY_KEY] });
  if (opts?.broadcast && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(`erp-${opts.broadcast}-change`));
  }
}

export function useInvalidateNavBadges() {
  const qc = useQueryClient();
  return useCallback(
    (opts?: { broadcast?: NavBadgeBroadcast }) => invalidateNavBadges(qc, opts),
    [qc],
  );
}

export function useInvalidateHutangBadges() {
  const invalidate = useInvalidateNavBadges();
  return useCallback(() => invalidate({ broadcast: 'hutang' }), [invalidate]);
}

export interface NavBadgesData {
  grnPending?: number;
  hutangReview?: number;
  wrPending?: number;
  pmOverdue?: number;
  pmDueSoon?: number;
}

function navBadgesUrl(): string | null {
  const user = getUser();
  if (!user) return null;
  const params = new URLSearchParams();
  if (user.role === 'MASTER') {
    const acting = getActingTenantId();
    if (!acting) return null;
    params.set('tenantId', acting);
  }
  const qs = params.toString();
  return `/api/nav-badges${qs ? `?${qs}` : ''}`;
}

export function useNavBadges(enabled = true) {
  const scopeKey = getActingTenantId() || getUser()?.tenantId || '';
  const url = navBadgesUrl();

  return useQuery({
    queryKey: [...NAV_BADGES_QUERY_KEY, scopeKey],
    queryFn: () => fetchJson<NavBadgesData>(url!),
    enabled: enabled && Boolean(url),
    staleTime: 45_000,
    refetchInterval: 45_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}
