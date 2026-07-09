/** Tarik status SO terbaru dari sales.app untuk sinkron cancel baris PO. */

import type { Db } from 'mongodb';
import { syncCpoFromSoPayload } from '@/lib/api/cpo-line-cancel-sync';
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
  return !(po.items as JsonObject[] | undefined)?.some((it) => it.cancelled);
}

/** Pull SO state dari sales.app dan patch PO jika ada perubahan baris. */
export async function pullSoCancelStateForPo(
  db: Db,
  po: JsonObject,
): Promise<{ updated: boolean; error?: string }> {
  const tenantId = String(po.tenantId || 'default');
  const subs = Array.isArray(po.vendorSubmissions) ? po.vendorSubmissions as JsonObject[] : [];
  const vendorTenantId = String(
    po.vendorTenantId === 'multi'
      ? subs[0]?.vendorTenantId || ''
      : po.vendorTenantId || subs[0]?.vendorTenantId || '',
  );

  const fetched = await fetchSoStatusForCustomerPo(db, tenantId, {
    customerPoId: String(po.id || ''),
    noPO: String(po.noPO || ''),
    noSO: String(po.vendorNoSO || ''),
    vendorTenantId: vendorTenantId || undefined,
  });
  if (fetched.error || !fetched.payload) return { updated: false, error: fetched.error };

  const preserveStatus = PRESERVE_PO_STATUS.has(String(po.status || ''));
  const payload = fetched.payload;
  const synced = syncCpoFromSoPayload(po, {
    salesOrderId: payload.salesOrderId,
    noSO: payload.noSO,
    noPO: payload.noPO || po.noPO,
    customerPoId: po.id,
    items: payload.items,
    cancelledLines: payload.cancelledItems || payload.cancelledLines,
    subTotal: payload.subTotal,
    ppn: payload.ppn,
    total: payload.total,
    updatedAt: payload.updatedAt,
  });

  const itemsChanged = JSON.stringify(synced.items) !== JSON.stringify(po.items);
  const nextStatus = preserveStatus ? String(po.status) : (synced.status || String(po.status));
  const statusChanged = !preserveStatus && synced.status && synced.status !== po.status;
  const auditChanged = JSON.stringify(synced.cancelledSoLines || []) !== JSON.stringify(po.cancelledSoLines || []);
  if (!itemsChanged && !statusChanged && !auditChanged) return { updated: false };

  await db.collection('customer_purchase_orders').updateOne(
    { id: po.id },
    {
      $set: {
        items: synced.items,
        ...(synced.vendorSoSnapshot ? { vendorSoSnapshot: synced.vendorSoSnapshot } : {}),
        ...(synced.cancelledSoLines ? { cancelledSoLines: synced.cancelledSoLines } : {}),
        ...(statusChanged ? { status: nextStatus } : {}),
        lastVendorEvent: 'sales_order.updated',
        lastVendorEventAt: new Date(),
        updatedAt: new Date(),
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
      // Tetap coba diff dari snapshot lokal jika pull gagal
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
    if (fresh) return fresh;
    const hasCancel = (po.items as JsonObject[] | undefined)?.some((it) => it.cancelled);
    if (hasCancel) return po;
    const snapItems = (po.vendorSoSnapshot as JsonObject | undefined)?.items;
    if (!Array.isArray(snapItems) || !snapItems.length) return po;
    if (snapItems.length >= (po.items as JsonObject[]).length) return po;
    const items = syncCpoFromSoPayload(po, {
      salesOrderId: po.vendorSoId,
      noSO: po.vendorNoSO,
      items: snapItems,
    }).items;
    return { ...po, items };
  });
}
