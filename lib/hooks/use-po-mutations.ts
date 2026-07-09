'use client';

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { JsonObject } from '@/types/json';
import { fetchOrQueue, OfflineQueuedError } from '@/lib/offline-mutation-queue';
import { isPendingOptimisticPo } from '@/lib/pembelian-po/helpers';

function assertPersistedPoId(id: string) {
  if (isPendingOptimisticPo({ id })) {
    throw new Error('PO masih disimpan — tunggu sebentar lalu coba lagi');
  }
}

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
    assertPersistedPoId(id);
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
      { status: 'APPROVED', approvalStatus: 'APPROVED', vendorSyncPending: true },
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
      { status: 'APPROVED', vendorSyncPending: true },
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

  const syncVendorForVendor = useCallback(async (id: string, vendorTenantId: string) => {
    return withOptimistic(
      id,
      { vendorSyncStatus: 'SYNCING' },
      () => fetchOrQueue(`/api/customer-purchase-orders/${id}/sync-vendor/${encodeURIComponent(vendorTenantId)}`, {
        method: 'POST',
        offlineLabel: `Sync vendor ${vendorTenantId} PO ${id}`,
      }),
    );
  }, [withOptimistic]);

  const syncSoLines = useCallback(async (id: string) => {
    const res = await fetchOrQueue(`/api/customer-purchase-orders/${id}/sync-so-lines`, {
      method: 'POST',
      offlineLabel: `Sync baris SO PO ${id}`,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal sync SO');
    await reload();
    return data;
  }, [reload]);

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
      if (optimisticRow) {
        setList((prev) => {
          const withoutTemp = prev.filter((row) => String(row.id) !== String(optimisticRow.id));
          return prependPoToList(withoutTemp, data as JsonObject);
        });
      }
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

  return { requestApproval, approve, reject, submit, syncVendor, syncVendorForVendor, syncSoLines, createPO, updatePO };
}
