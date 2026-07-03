'use client';

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { JsonObject } from '@/types/json';
import { fetchOrQueue, OfflineQueuedError } from '@/lib/offline-mutation-queue';

function patchPoList(
  list: JsonObject[],
  id: string,
  patch: Record<string, unknown>,
): JsonObject[] {
  return list.map((row) => (String(row.id) === id ? { ...row, ...patch } : row));
}

function prependPoToList(list: JsonObject[], row: JsonObject): JsonObject[] {
  return [row, ...list];
}

export function usePoMutations(
  setList: Dispatch<SetStateAction<JsonObject[]>>,
  reload: () => Promise<void>,
) {
  const withOptimistic = useCallback(async (
    id: string,
    optimisticPatch: Record<string, unknown>,
    run: () => Promise<Response>,
  ) => {
    let snapshot: JsonObject[] = [];
    setList((prev) => {
      snapshot = prev;
      return patchPoList(prev, id, optimisticPatch);
    });

    try {
      const res = await run();
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      await reload();
      return data;
    } catch (e) {
      if (e instanceof OfflineQueuedError) throw e;
      setList(snapshot);
      throw e;
    }
  }, [setList, reload]);

  const requestApproval = useCallback(async (id: string) => {
    return withOptimistic(
      id,
      { status: 'PENDING_APPROVAL', approvalStatus: 'PENDING_APPROVAL' },
      () => fetchOrQueue(`/api/customer-purchase-orders/${id}/request-approval`, {
        method: 'POST',
        offlineLabel: `Ajukan PO ${id}`,
      }),
    );
  }, [withOptimistic]);

  const approve = useCallback(async (id: string) => {
    return withOptimistic(
      id,
      { status: 'APPROVED', approvalStatus: 'APPROVED' },
      () => fetchOrQueue(`/api/customer-purchase-orders/${id}/approve`, {
        method: 'POST',
        offlineLabel: `Setujui PO ${id}`,
      }),
    );
  }, [withOptimistic]);

  const reject = useCallback(async (id: string, reason = 'Ditolak admin') => {
    return withOptimistic(
      id,
      { status: 'REJECTED', approvalStatus: 'REJECTED', rejectReason: reason },
      () => fetchOrQueue(`/api/customer-purchase-orders/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
        offlineLabel: `Tolak PO ${id}`,
      }),
    );
  }, [withOptimistic]);

  const submit = useCallback(async (id: string) => {
    return withOptimistic(
      id,
      { status: 'SUBMITTED' },
      () => fetchOrQueue(`/api/customer-purchase-orders/${id}/submit`, {
        method: 'POST',
        offlineLabel: `Kirim PO ${id}`,
      }),
    );
  }, [withOptimistic]);

  const syncVendor = useCallback(async (id: string) => {
    return withOptimistic(
      id,
      { vendorSyncStatus: 'SYNCING' },
      () => fetchOrQueue(`/api/customer-purchase-orders/${id}/sync-vendor`, {
        method: 'POST',
        offlineLabel: `Sync vendor PO ${id}`,
      }),
    );
  }, [withOptimistic]);

  const createPO = useCallback(async (
    payload: Record<string, unknown>,
    optimisticRow?: JsonObject,
  ) => {
    let snapshot: JsonObject[] = [];
    setList((prev) => {
      snapshot = prev;
      return optimisticRow ? prependPoToList(prev, optimisticRow) : prev;
    });

    try {
      const res = await fetchOrQueue('/api/customer-purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        offlineLabel: 'Buat PO customer',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      await reload();
      return data;
    } catch (e) {
      if (e instanceof OfflineQueuedError) throw e;
      setList(snapshot);
      throw e;
    }
  }, [setList, reload]);

  const updatePO = useCallback(async (
    id: string,
    payload: Record<string, unknown>,
    optimisticPatch?: Record<string, unknown>,
  ) => {
    return withOptimistic(
      id,
      optimisticPatch || { status: 'DRAFT' },
      () => fetchOrQueue(`/api/customer-purchase-orders/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        offlineLabel: `Ubah PO ${id}`,
      }),
    );
  }, [withOptimistic]);

  return { requestApproval, approve, reject, submit, syncVendor, createPO, updatePO };
}
