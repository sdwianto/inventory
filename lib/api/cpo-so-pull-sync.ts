/** Tarik status SO terbaru dari sales.app untuk sinkron cancel baris PO. */

import type { Db } from 'mongodb';
import {
  syncCpoFromSoPayload,
  rollupPartialCancelStatus,
  diffPoItemsAgainstActiveSo,
  applyCancelledLinesToPoItems,
  applySoCancelledWebhookToPoItems,
  type CpoLineCancelRecord,
} from '@/lib/api/cpo-line-cancel-sync';
import { fetchSoStatusForCustomerPo } from '@/lib/api/cpo-so-fetch';
import {
  enrichSubmissionsWithSoFromSales,
  poHasVendorSoNumbers,
  summarizeVendorNoSo,
  submissionHasVendorSo,
} from '@/lib/api/customer-po-so-extract';
import { buildVendorSoSnapshot } from '@/lib/api/vendor-so-snapshot';
import type { JsonObject } from '@/types/json';

/** Status PO yang tidak boleh diturunkan saat sync cancel baris dari SO. */
const PRESERVE_PO_STATUS = new Set([
  'PARTIAL_RECEIVED', 'RECEIVED', 'INVOICED', 'CANCELLED',
  // PO yang sudah dikirim vendor: jangan turunkan status hanya karena mismatch sync
  'SHIPPED', 'PARTIAL_SHIPPED',
]);

/** Status PO yang perlu pull status SO dari sales.app. */
const SO_PULL_STATUSES = new Set([
  'SUBMITTED', 'CONFIRMED', 'PARTIAL_CANCELLED',
  'PARTIAL_SHIPPED', 'SHIPPED', 'PARTIAL_RECEIVED', 'RECEIVED', 'INVOICED',
]);

function poNeedsSoBackfill(po: JsonObject): boolean {
  const st = String(po.status || '');
  if (!SO_PULL_STATUSES.has(st)) return false;
  if (!String(po.noPO || '')) return false;
  return !poHasVendorSoNumbers(po);
}

function vendorIdsFromPo(po: JsonObject): string[] {
  const subs = Array.isArray(po.vendorSubmissions) ? po.vendorSubmissions as JsonObject[] : [];
  const fromSubs = subs.map((s) => String(s.vendorTenantId || '')).filter(Boolean);
  if (fromSubs.length) return [...new Set(fromSubs)];
  const fromItems = (Array.isArray(po.items) ? po.items as JsonObject[] : [])
    .map((it) => String(it.vendorTenantId || ''))
    .filter(Boolean);
  return [...new Set(fromItems)];
}

function isMultiVendorPo(po: JsonObject): boolean {
  if (String(po.vendorTenantId || '') === 'multi') return true;
  return vendorIdsFromPo(po).length > 1;
}

/** Backfill nomor SO yang hilang setelah submit (lookup sales.app). */
export async function backfillPoVendorSoFromSales(
  db: Db,
  po: JsonObject,
): Promise<{ updated: boolean; error?: string }> {
  if (poHasVendorSoNumbers(po)) return { updated: false };

  const tenantId = String(po.tenantId || 'default');
  const vendorIds = vendorIdsFromPo(po);
  const existingSubs = Array.isArray(po.vendorSubmissions) ? po.vendorSubmissions as JsonObject[] : [];

  let syncedSubs: JsonObject[];
  if (existingSubs.length) {
    syncedSubs = await enrichSubmissionsWithSoFromSales(db, po, existingSubs);
  } else if (vendorIds.length) {
    syncedSubs = [];
    for (const vendorTenantId of vendorIds) {
      const fetched = await fetchSoStatusForCustomerPo(db, tenantId, {
        customerPoId: String(po.id || ''),
        noPO: String(po.noPO || ''),
        vendorTenantId,
      });
      const payload = fetched.payload;
      if (!payload?.noSO && !payload?.salesOrderId) continue;
      syncedSubs.push({
        vendorTenantId,
        status: 'SYNCED',
        vendorSoId: payload.salesOrderId,
        vendorNoSO: payload.noSO,
        vendorSo: payload,
      });
    }
  } else {
    const fetched = await fetchSoStatusForCustomerPo(db, tenantId, {
      customerPoId: String(po.id || ''),
      noPO: String(po.noPO || ''),
    });
    if (fetched.error || !fetched.payload?.noSO) {
      return { updated: false, error: fetched.error };
    }
    const payload = fetched.payload;
    syncedSubs = [{
      vendorTenantId: po.vendorTenantId || '',
      status: 'SYNCED',
      vendorSoId: payload.salesOrderId,
      vendorNoSO: payload.noSO,
      vendorSo: payload,
    }];
  }

  if (!syncedSubs.some(submissionHasVendorSo)) {
    return { updated: false, error: 'SO tidak ditemukan di sales.app' };
  }

  const primary = syncedSubs[0];
  const soSnap = buildVendorSoSnapshot({
    ...(primary.vendorSo as JsonObject),
    salesOrderId: primary.vendorSoId,
    noSO: primary.vendorNoSO,
  });

  await db.collection('customer_purchase_orders').updateOne(
    { id: po.id },
    {
      $set: {
        vendorSubmissions: syncedSubs,
        vendorTenantId: syncedSubs.length === 1
          ? primary.vendorTenantId
          : (syncedSubs.length > 1 ? 'multi' : po.vendorTenantId),
        vendorSoId: primary.vendorSoId,
        vendorNoSO: syncedSubs.length === 1 ? primary.vendorNoSO : summarizeVendorNoSo(syncedSubs),
        ...(soSnap ? { vendorSoSnapshot: soSnap } : {}),
        updatedAt: new Date(),
      },
    },
  );
  return { updated: true };
}

function poNeedsSoPull(po: JsonObject): boolean {
  const st = String(po.status || '');
  if (!SO_PULL_STATUSES.has(st)) return false;
  if (!String(po.noPO || '')) return false;
  if (!poHasVendorSoNumbers(po)) return false;
  // Tetap pull meskipun ada baris cancelled — agar mismatch sync bisa dipulihkan
  return true;
}

type CpoLine = JsonObject & {
  cancelled?: boolean;
  vendorTenantId?: string;
  kode?: string;
  nama?: string;
  qty?: number | string;
};

/** Pull SO state dari sales.app — per vendor agar item vendor lain tidak ikut tercoret. */
export async function pullSoCancelStateForPo(
  db: Db,
  po: JsonObject,
): Promise<{ updated: boolean; error?: string }> {
  const tenantId = String(po.tenantId || 'default');
  const subs = Array.isArray(po.vendorSubmissions) ? po.vendorSubmissions as JsonObject[] : [];
  const multi = isMultiVendorPo(po);

  const targets: Array<{ vendorTenantId: string; noSO?: string }> = [];
  if (subs.length) {
    for (const s of subs) {
      const vid = String(s.vendorTenantId || '').trim();
      if (!vid) continue;
      targets.push({
        vendorTenantId: vid,
        noSO: String(s.vendorNoSO || '').trim() || undefined,
      });
    }
  }
  if (!targets.length) {
    const vid = String(po.vendorTenantId === 'multi' ? '' : po.vendorTenantId || '').trim();
    targets.push({
      vendorTenantId: vid,
      noSO: String(po.vendorNoSO || '').trim() || undefined,
    });
  }

  let items = (Array.isArray(po.items) ? [...po.items] : []) as CpoLine[];
  let cancelledSoLines = Array.isArray(po.cancelledSoLines)
    ? [...(po.cancelledSoLines as JsonObject[])]
    : undefined;
  let primarySnap: ReturnType<typeof buildVendorSoSnapshot> | undefined;
  let lastError: string | undefined;
  let anyFetchOk = false;
  const now = new Date();

  for (const target of targets) {
    const fetched = await fetchSoStatusForCustomerPo(db, tenantId, {
      customerPoId: String(po.id || ''),
      noPO: String(po.noPO || ''),
      noSO: target.noSO,
      vendorTenantId: target.vendorTenantId || undefined,
    });
    if (fetched.error || !fetched.payload) {
      lastError = fetched.error;
      continue;
    }
    anyFetchOk = true;
    const payload = fetched.payload;
    const vendorId = String(target.vendorTenantId || payload.vendorTenantId || '').trim();
    const meta = {
      salesOrderId: String(payload.salesOrderId || ''),
      noSO: String(payload.noSO || target.noSO || ''),
      vendorTenantId: vendorId || undefined,
    };

    const cancelledRaw = [
      ...(Array.isArray(payload.cancelledItems) ? payload.cancelledItems : []),
      ...(Array.isArray(payload.cancelledLines) ? payload.cancelledLines : []),
    ] as CpoLineCancelRecord[];
    const soStatus = String(payload.status || '').toUpperCase();

    // SO penuh CANCELLED di sales — batalkan baris vendor (bukan hanya match lineId).
    if (soStatus === 'CANCELLED') {
      const cancelSync = applySoCancelledWebhookToPoItems(
        items,
        {
          cancelledItems: cancelledRaw,
          reason: String(payload.cancelReason || payload.reason || 'SO dibatalkan di sales.app'),
          vendorTenantId: vendorId || undefined,
        },
        meta,
        String(po.status || 'SUBMITTED'),
        now,
      );
      items = cancelSync.items as CpoLine[];
      if (cancelSync.cancelledSoLines?.length) {
        cancelledSoLines = [
          ...(cancelledSoLines || []),
          ...cancelSync.cancelledSoLines,
        ];
      }
    } else {
      if (cancelledRaw.length) {
        items = applyCancelledLinesToPoItems(items, cancelledRaw, meta, now) as CpoLine[];
      }

      const activeItems = Array.isArray(payload.items) ? payload.items as JsonObject[] : [];
      if (activeItems.length) {
        items = diffPoItemsAgainstActiveSo(
          items,
          activeItems,
          meta,
          now,
          vendorId
            ? { vendorTenantId: vendorId, onlyVendorLines: multi }
            : undefined,
        ) as CpoLine[];
      }
    }

    const snap = buildVendorSoSnapshot({
      ...payload,
      salesOrderId: payload.salesOrderId,
      noSO: payload.noSO,
    });
    if (snap && !primarySnap) primarySnap = snap;
  }

  if (!anyFetchOk) return { updated: false, error: lastError };

  const reconciledStatus = rollupPartialCancelStatus(
    items as Parameters<typeof rollupPartialCancelStatus>[0],
    String(po.status || ''),
  );
  const preserveHard = PRESERVE_PO_STATUS.has(String(po.status || ''));
  const nextStatus = preserveHard ? String(po.status) : reconciledStatus;
  const statusChanged = !preserveHard && nextStatus !== po.status;
  const itemsChanged = JSON.stringify(items) !== JSON.stringify(po.items);
  if (!itemsChanged && !statusChanged) return { updated: false };

  await db.collection('customer_purchase_orders').updateOne(
    { id: po.id },
    {
      $set: {
        items,
        ...(primarySnap ? { vendorSoSnapshot: primarySnap } : {}),
        ...(cancelledSoLines?.length ? { cancelledSoLines } : {}),
        ...(statusChanged ? { status: nextStatus } : {}),
        lastVendorEvent: 'sales_order.updated',
        lastVendorEventAt: now,
        updatedAt: now,
      },
    },
  );
  return { updated: true };
}

export async function enrichPoListWithSoCancelState(
  db: Db,
  pos: JsonObject[],
): Promise<JsonObject[]> {
  const needsBackfill = pos.filter(poNeedsSoBackfill).slice(0, 5);
  const backfilled = new Map<string, JsonObject>();
  for (const po of needsBackfill) {
    const result = await backfillPoVendorSoFromSales(db, po);
    if (result.updated) {
      const fresh = await db.collection('customer_purchase_orders').findOne({ id: po.id }) as JsonObject | null;
      if (fresh) backfilled.set(String(po.id), fresh);
    }
  }

  const posWithSo = pos.map((po) => backfilled.get(String(po.id)) || po);
  const eligible = posWithSo.filter(poNeedsSoPull);

  const pulled = new Map<string, JsonObject>();
  await Promise.all(eligible.slice(0, 30).map(async (po) => {
    const result = await pullSoCancelStateForPo(db, po);
    if (result.updated) {
      const fresh = await db.collection('customer_purchase_orders').findOne({ id: po.id }) as JsonObject | null;
      if (fresh) pulled.set(String(po.id), fresh);
    } else if (result.error) {
      // Snapshot lokal hanya aman untuk PO single-vendor
      if (isMultiVendorPo(po)) return;
      const snapItems = (po.vendorSoSnapshot as JsonObject | undefined)?.items;
      if (Array.isArray(snapItems) && snapItems.length && snapItems.length < (po.items as JsonObject[]).length) {
        const items = syncCpoFromSoPayload(po, {
          salesOrderId: po.vendorSoId,
          noSO: po.vendorNoSO,
          items: snapItems,
        }).items;
        if (JSON.stringify(items) !== JSON.stringify(po.items)) {
          pulled.set(String(po.id), { ...po, items });
        }
      }
    }
  }));

  return posWithSo.map((po) => {
    const fresh = pulled.get(String(po.id));
    const row = fresh || po;
    const items = (row.items || []) as JsonObject[];
    const repairedStatus = rollupPartialCancelStatus(items as Parameters<typeof rollupPartialCancelStatus>[0], String(row.status || ''));
    if (
      repairedStatus !== row.status
      && !PRESERVE_PO_STATUS.has(String(row.status || ''))
    ) {
      void db.collection('customer_purchase_orders').updateOne(
        { id: row.id },
        { $set: { status: repairedStatus, updatedAt: new Date() }, ...(repairedStatus !== 'CANCELLED' ? { $unset: { cancelledAt: '', cancelReason: '' } } : {}) },
      );
      return { ...row, status: repairedStatus };
    }
    if (fresh) return fresh;
    const hasCancel = items.some((it) => it.cancelled);
    if (hasCancel) return row;
    // Jangan coret dari snapshot tunggal pada PO multi-vendor
    if (isMultiVendorPo(po)) return po;
    const snapItems = (po.vendorSoSnapshot as JsonObject | undefined)?.items;
    if (!Array.isArray(snapItems) || !snapItems.length) return po;
    if (snapItems.length >= (po.items as JsonObject[]).length) return po;
    const syncedItems = syncCpoFromSoPayload(po, {
      salesOrderId: po.vendorSoId,
      noSO: po.vendorNoSO,
      items: snapItems,
    }).items;
    return { ...po, items: syncedItems };
  });
}
