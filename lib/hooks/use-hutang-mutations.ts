'use client';

import { useCallback } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { JsonObject } from '@/types/json';
import { queryKeys } from '@/lib/query-keys';
import { invalidateNavBadges } from '@/lib/hooks/use-nav-badges';
import type { CursorPage } from '@/lib/hooks/use-cursor-query';
import { fetchOrQueue, OfflineQueuedError } from '@/lib/offline-mutation-queue';

type HutangPages = InfiniteData<CursorPage<JsonObject>>;

function removeHutangFromCache(
  data: HutangPages | undefined,
  hutangId: string,
): HutangPages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: (page.items || []).filter((row) => String(row.id) !== hutangId),
    })),
  };
}

function patchHutangInCache(
  data: HutangPages | undefined,
  hutangId: string,
  patch: Record<string, unknown>,
): HutangPages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: (page.items || []).map((row) => (
        String(row.id) === hutangId ? { ...row, ...patch } : row
      )),
    })),
  };
}

export function useHutangMutations(tab: string, reload: () => Promise<void>) {
  const qc = useQueryClient();
  const listKey = queryKeys.pages.hutang({ approvalStatus: tab });

  const refreshAfterMutation = useCallback(async () => {
    invalidateNavBadges(qc, { broadcast: 'hutang' });
    void qc.invalidateQueries({ queryKey: ['pages', 'hutang'] });
    void qc.invalidateQueries({ queryKey: queryKeys.hutang.all });
    await reload();
  }, [qc, reload]);

  const approve = useCallback(async (
    hutangId: string,
    body: { overrideMatch?: boolean; note?: string },
  ) => {
    const previous = qc.getQueryData<HutangPages>(listKey);
    qc.setQueryData<HutangPages>(listKey, (old) => removeHutangFromCache(old, hutangId));

    try {
      const res = await fetchOrQueue(`/api/hutang/${hutangId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        offlineLabel: `Setujui hutang ${hutangId}`,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal menyetujui');
      await refreshAfterMutation();
      return data;
    } catch (e) {
      if (e instanceof OfflineQueuedError) throw e;
      if (previous) qc.setQueryData(listKey, previous);
      throw e;
    }
  }, [qc, listKey, refreshAfterMutation]);

  const reject = useCallback(async (hutangId: string, reason: string) => {
    const previous = qc.getQueryData<HutangPages>(listKey);
    qc.setQueryData<HutangPages>(listKey, (old) => removeHutangFromCache(old, hutangId));

    try {
      const res = await fetchOrQueue(`/api/hutang/${hutangId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
        offlineLabel: `Tolak hutang ${hutangId}`,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal menolak');
      await refreshAfterMutation();
      return data;
    } catch (e) {
      if (e instanceof OfflineQueuedError) throw e;
      if (previous) qc.setQueryData(listKey, previous);
      throw e;
    }
  }, [qc, listKey, refreshAfterMutation]);

  const markPaidExternal = useCallback(async (hutangId: string, note?: string) => {
    const previous = qc.getQueryData<HutangPages>(listKey);
    qc.setQueryData<HutangPages>(listKey, (old) => patchHutangInCache(old, hutangId, {
      approvalStatus: 'PAID_EXTERNAL',
      status: 'PAID_EXTERNAL',
    }));

    try {
      const res = await fetchOrQueue(`/api/hutang/${hutangId}/mark-paid-external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note || 'Pembayaran dilakukan di luar sistem' }),
        offlineLabel: `Lunas eksternal ${hutangId}`,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      await refreshAfterMutation();
      return data;
    } catch (e) {
      if (e instanceof OfflineQueuedError) throw e;
      if (previous) qc.setQueryData(listKey, previous);
      throw e;
    }
  }, [qc, listKey, refreshAfterMutation]);

  return { approve, reject, markPaidExternal };
}
