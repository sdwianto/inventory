'use client';

import { useCallback } from 'react';
import { useQueryClient, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import type { JsonObject } from '@/types/json';
import type { CursorPage } from '@/lib/hooks/use-cursor-query';
import { fetchOrQueue, OfflineQueuedError } from '@/lib/offline-mutation-queue';

type GrnPages = InfiniteData<CursorPage<JsonObject>>;

function patchGrnInCache(
  data: GrnPages | undefined,
  id: string,
  patch: Partial<JsonObject>,
): GrnPages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: (page.items || []).map((row) => (
        String(row.id) === String(id) ? { ...row, ...patch } : row
      )),
    })),
  };
}

function grnPatchFromResponse(data: JsonObject): Partial<JsonObject> {
  const invoiceSync = data.invoiceSync as JsonObject | undefined;
  return {
    status: data.status || 'POSTED',
    invoiceSyncStatus: data.invoiceSyncStatus || invoiceSync?.status,
    invoiceSyncError: data.invoiceSyncError,
    noInvoice: data.noInvoice,
    lokasi: data.lokasi,
    receivedTotal: data.receivedTotal,
    postedAt: data.postedAt,
    hutangId: data.hutangId,
    items: data.items,
  };
}

export function useGrnMutations(
  listKey: QueryKey,
  reload: () => Promise<void>,
  invalidateGrn: () => void,
) {
  const qc = useQueryClient();

  const postGrn = useCallback(async (
    grnId: string,
    items: Array<{ lineId?: unknown; lineIndex: number; qty: number; lokasiKode: string }>,
  ) => {
    const previous = qc.getQueryData<GrnPages>(listKey);
    qc.setQueryData<GrnPages>(listKey, (old) => patchGrnInCache(old, grnId, {
      status: 'POSTED',
      // P0: in-flight = SYNCING (bukan PENDING legacy).
      invoiceSyncStatus: 'SYNCING',
    }));

    try {
      const res = await fetchOrQueue(`/api/goods-receipts/${grnId}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
        offlineLabel: `Post GRN ${grnId}`,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      qc.setQueryData<GrnPages>(listKey, (old) => patchGrnInCache(old, grnId, grnPatchFromResponse(data)));
      invalidateGrn();
      return data;
    } catch (e) {
      if (e instanceof OfflineQueuedError) throw e;
      if (previous) qc.setQueryData(listKey, previous);
      throw e;
    }
  }, [qc, listKey, invalidateGrn]);

  const replayInvoice = useCallback(async (id: string) => {
    const previous = qc.getQueryData<GrnPages>(listKey);
    qc.setQueryData<GrnPages>(listKey, (old) => patchGrnInCache(old, id, {
      invoiceSyncStatus: 'SYNCING',
    }));

    try {
      const res = await fetchOrQueue(`/api/goods-receipts/${id}/replay-invoice`, {
        method: 'POST',
        offlineLabel: `Replay faktur GRN ${id}`,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal buat faktur');
      qc.setQueryData<GrnPages>(listKey, (old) => patchGrnInCache(old, id, grnPatchFromResponse(data)));
      invalidateGrn();
      return data;
    } catch (e) {
      if (e instanceof OfflineQueuedError) throw e;
      if (previous) qc.setQueryData(listKey, previous);
      throw e;
    }
  }, [qc, listKey, invalidateGrn]);

  const syncFromSales = useCallback(async () => {
    const res = await fetchOrQueue('/api/goods-receipts/sync-shipped', {
      method: 'POST',
      offlineLabel: 'Sync DO dari sales',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal sync');
    invalidateGrn();
    await reload();
    return { res, data };
  }, [invalidateGrn, reload]);

  return { postGrn, replayInvoice, syncFromSales };
}
