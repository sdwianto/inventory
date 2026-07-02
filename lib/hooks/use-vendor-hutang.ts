'use client';

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NAV_BADGES_QUERY_KEY } from '@/lib/hooks/use-nav-badges';

/** Refresh list + badge di halaman yang sama — tanpa broadcast (hindari double reload). */
export function useHutangPageRefresh(reload: () => Promise<void>) {
  const qc = useQueryClient();
  return useCallback(async () => {
    await qc.invalidateQueries({ queryKey: [...NAV_BADGES_QUERY_KEY] });
    await reload();
  }, [qc, reload]);
}
