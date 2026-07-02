'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '@/lib/fetch-json';
import { BADGE_POLL_MS } from '@/lib/constants/badge-poll';

export const NAV_BADGES_QUERY_KEY = ['nav-badges'] as const;

export interface NavBadgesData {
  grnPending?: number;
  hutangReview?: number;
  wrPending?: number;
  pmOverdue?: number;
  pmDueSoon?: number;
}

export function useNavBadges(enabled = true) {
  return useQuery({
    queryKey: [...NAV_BADGES_QUERY_KEY],
    queryFn: () => fetchJson<NavBadgesData>('/api/nav-badges'),
    staleTime: 60_000,
    enabled,
    refetchInterval: enabled ? BADGE_POLL_MS : false,
    refetchIntervalInBackground: false,
  });
}
