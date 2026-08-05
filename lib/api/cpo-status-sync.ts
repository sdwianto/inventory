import type { Db } from 'mongodb';
// Sinkron status Customer PO dari webhook vendor (sales.app).

import { syncCpoFromSoPayload, applySoCancelledWebhookToPoItems } from '@/lib/api/cpo-line-cancel-sync';
import { findMatchingGrnLine, findMatchingVendorWebhookLine, type LocalPoLineLike } from '@/lib/uom/match-vendor-line';
import type { JsonObject } from '@/types/json';

type CpoLine = JsonObject & {
  qty?: number | string;
  qtyShipped?: number;
  qtyReceived?: number;
};

type CpoDoc = JsonObject & {
  id?: string;
  noPO?: string;
  status?: string;
  items?: CpoLine[];
  vendorSoId?: string;
  vendorNoSO?: string;
  vendorNoDO?: string;
  vendorNoDOMap?: Record<string, string | null>;
  vendorNoInvoice?: string;
  vendorInvoiceId?: string;
  appliedShipDeliveryIds?: string[];
  appliedReceiveGrnIds?: string[];
  qtySyncVersion?: number;
};

const QTY_SYNC_RETRIES = 8;

function findCpoFilter(tenantId: string, payload: Record<string, unknown>) {
  const base = { tenantId };
  if (payload.customerPoId) return { ...base, id: payload.customerPoId };
  if (payload.noPO) return { ...base, noPO: payload.noPO };
  if (payload.salesOrderId) return { ...base, vendorSoId: payload.salesOrderId };
  if (payload.noSO) return { ...base, vendorNoSO: payload.noSO };
  return null;
}

function lineQtyTarget(line: CpoLine): number {
  if (line.cancelled) return 0;
  return parseFloat(String(line.qty)) || 0;
}

function rollupShipStatus(items: CpoLine[]) {
  const active = items.filter((it) => lineQtyTarget(it) > 0);
  if (!active.length) {
    const anyShipped = items.some((it) => (Number(it.qtyShipped) || 0) > 0);
    return anyShipped ? 'SHIPPED' : 'CONFIRMED';
  }
  const allShipped = active.every((it) => (Number(it.qtyShipped) || 0) >= lineQtyTarget(it));
  const anyShipped = active.some((it) => (Number(it.qtyShipped) || 0) > 0)
    || items.some((it) => it.cancelled && (Number(it.qtyShipped) || 0) > 0);
  if (allShipped) return 'SHIPPED';
  if (anyShipped) return 'PARTIAL_SHIPPED';
  return 'CONFIRMED';
}

function rollupReceiveStatus(items: CpoLine[]) {
  const active = items.filter((it) => lineQtyTarget(it) > 0);
  if (!active.length) {
    const anyReceived = items.some((it) => (Number(it.qtyReceived) || 0) > 0);
    return anyReceived ? 'RECEIVED' : 'SHIPPED';
  }
  const allReceived = active.every((it) => (Number(it.qtyReceived) || 0) >= lineQtyTarget(it));
  const anyReceived = active.some((it) => (Number(it.qtyReceived) || 0) > 0);
  if (allReceived) return 'RECEIVED';
  if (anyReceived) return 'PARTIAL_RECEIVED';
  return 'SHIPPED';
}

function hasAppliedId(list: unknown, id: string): boolean {
  if (!id || !Array.isArray(list)) return false;
  return list.some((x) => String(x) === id);
}

/** Filter optimistic concurrency — field belum ada dianggap versi 0. */
function qtySyncVersionFilter(poId: string, ver: number, extra: Record<string, unknown> = {}) {
  return {
    id: poId,
    ...extra,
    $or: ver === 0
      ? [{ qtySyncVersion: { $exists: false } }, { qtySyncVersion: 0 }]
      : [{ qtySyncVersion: ver }],
  };
}

async function applyDeliveryShipped(
  db: Db,
  lookupFilter: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const deliveryId = String(payload.deliveryId || '').trim();
  if (!deliveryId) {
    return { action: 'skipped', reason: 'missing_delivery_id' };
  }

  const now = new Date();
  for (let attempt = 0; attempt < QTY_SYNC_RETRIES; attempt++) {
    const po = await db.collection('customer_purchase_orders').findOne(lookupFilter) as CpoDoc | null;
    if (!po) return { action: 'not_found', filter: lookupFilter };
    if (hasAppliedId(po.appliedShipDeliveryIds, deliveryId)) {
      return { action: 'skipped', reason: 'already_applied', deliveryId, poId: po.id };
    }

    const ver = Number(po.qtySyncVersion) || 0;
    const usedShip = new Set<number>();
    const webhookItems = Array.isArray(payload.items) ? payload.items as JsonObject[] : [];
    const items = (po.items || []).map((line) => {
      const shipped = findMatchingVendorWebhookLine(line as LocalPoLineLike, webhookItems, usedShip);
      const add = parseFloat(String(shipped?.qty)) || 0;
      return { ...line, qtyShipped: (Number(line.qtyShipped) || 0) + add };
    });

    const patch: Record<string, unknown> = {
      items,
      status: rollupShipStatus(items),
      shippedAt: payload.shippedAt ? new Date(String(payload.shippedAt)) : now,
      vendorNoDO: payload.noDO || po.vendorNoDO,
      updatedAt: now,
      lastVendorEvent: 'delivery.shipped',
      lastVendorEventAt: now,
      qtySyncVersion: ver + 1,
    };
    if (payload.vendorTenantId) {
      const map = { ...(po.vendorNoDOMap || {}) };
      map[String(payload.vendorTenantId)] = (payload.noDO as string) || map[String(payload.vendorTenantId)] || null;
      patch.vendorNoDOMap = map;
    }

    const result = await db.collection('customer_purchase_orders').updateOne(
      qtySyncVersionFilter(String(po.id), ver, { appliedShipDeliveryIds: { $ne: deliveryId } }),
      { $set: patch, $addToSet: { appliedShipDeliveryIds: deliveryId } },
    );
    if (result.matchedCount > 0) {
      return { action: 'updated', poId: po.id, noPO: po.noPO, status: patch.status };
    }
  }
  return { action: 'skipped', reason: 'concurrent_conflict', deliveryId };
}

export async function syncCpoFromVendorEvent(
  db: Db,
  tenantId: string,
  event: string,
  payload: Record<string, unknown>,
) {
  const filter = findCpoFilter(tenantId, payload);
  if (!filter) return { action: 'skipped', reason: 'no_po_reference' };

  if (event === 'delivery.shipped') {
    return applyDeliveryShipped(db, filter, payload);
  }

  const po = await db.collection('customer_purchase_orders').findOne(filter) as CpoDoc | null;
  if (!po) return { action: 'not_found', filter };

  const now = new Date();
  const patch: Record<string, unknown> = { updatedAt: now, lastVendorEvent: event, lastVendorEventAt: now };

  if (event === 'sales_order.confirmed' || event === 'sales_order.updated') {
    const soSynced = syncCpoFromSoPayload(po, payload, now);
    if (event === 'sales_order.confirmed') {
      patch.confirmedAt = payload.confirmedAt ? new Date(String(payload.confirmedAt)) : now;
      if (soSynced.status === 'PARTIAL_CANCELLED' || soSynced.status === 'CANCELLED') {
        patch.status = soSynced.status;
      } else {
        patch.status = 'CONFIRMED';
      }
    } else if (soSynced.status) {
      patch.status = soSynced.status;
    }
    patch.vendorSoId = payload.salesOrderId || po.vendorSoId;
    patch.vendorNoSO = payload.noSO || po.vendorNoSO;
    patch.items = soSynced.items;
    if (soSynced.vendorSoSnapshot) patch.vendorSoSnapshot = soSynced.vendorSoSnapshot;
    if (soSynced.cancelledSoLines) patch.cancelledSoLines = soSynced.cancelledSoLines;
    const subs = Array.isArray(po.vendorSubmissions) ? [...po.vendorSubmissions] as JsonObject[] : [];
    if (subs.length && soSynced.vendorSoSnapshot) {
      const soId = String(payload.salesOrderId || '');
      const noSO = String(payload.noSO || '');
      patch.vendorSubmissions = subs.map((sub) => {
        const match = (soId && sub.vendorSoId === soId) || (noSO && sub.vendorNoSO === noSO);
        return match ? { ...sub, vendorSo: payload } : sub;
      });
    }
  } else if (event === 'sales_order.cancelled') {
    const meta = {
      salesOrderId: String(payload.salesOrderId || po.vendorSoId || ''),
      noSO: String(payload.noSO || po.vendorNoSO || ''),
    };
    const cancelSync = applySoCancelledWebhookToPoItems(
      (Array.isArray(po.items) ? po.items : []) as CpoLine[],
      {
        cancelledItems: Array.isArray(payload.cancelledItems)
          ? payload.cancelledItems as Parameters<typeof applySoCancelledWebhookToPoItems>[1]['cancelledItems']
          : undefined,
        reason: String(payload.reason || payload.cancelReason || 'Dibatalkan vendor'),
        vendorTenantId: payload.vendorTenantId ? String(payload.vendorTenantId) : undefined,
      },
      meta,
      String(po.status || 'SUBMITTED'),
      now,
    );
    patch.status = cancelSync.status;
    patch.items = cancelSync.items;
    if (cancelSync.cancelledSoLines) patch.cancelledSoLines = cancelSync.cancelledSoLines;
    if (cancelSync.status === 'CANCELLED') {
      patch.cancelledAt = payload.cancelledAt ? new Date(String(payload.cancelledAt)) : now;
      patch.cancelReason = payload.reason || payload.cancelReason || 'Dibatalkan vendor';
    }
    const subs = Array.isArray(po.vendorSubmissions) ? [...po.vendorSubmissions] as JsonObject[] : [];
    if (subs.length) {
      const soId = meta.salesOrderId;
      const noSO = meta.noSO;
      patch.vendorSubmissions = subs.map((sub) => {
        const match = (soId && sub.vendorSoId === soId) || (noSO && sub.vendorNoSO === noSO);
        return match ? { ...sub, status: 'CANCELLED', cancelReason: payload.reason || payload.cancelReason, vendorSo: payload } : sub;
      });
    }
  } else if (event === 'invoice.posted') {
    // PO multi-vendor: jangan paksa INVOICED kalau masih ada item vendor lain
    // yang aktif (belum shipped/received) atau baru dibatalkan — ikuti rollup
    // ship/receive sebenarnya, baru INVOICED kalau semua item aktif sudah RECEIVED.
    const items = (Array.isArray(po.items) ? po.items : []) as CpoLine[];
    const receiveStatus = rollupReceiveStatus(items);
    patch.status = receiveStatus === 'RECEIVED' ? 'INVOICED' : receiveStatus;
    patch.invoicedAt = payload.postedAt ? new Date(String(payload.postedAt)) : now;
    patch.vendorNoInvoice = payload.noInvoice || po.vendorNoInvoice;
    patch.vendorInvoiceId = payload.invoiceId || po.vendorInvoiceId;
    patch.invoiceTotal = parseInt(String(payload.total || 0), 10);
  }

  await db.collection('customer_purchase_orders').updateOne({ id: po.id }, { $set: patch });
  return { action: 'updated', poId: po.id, noPO: po.noPO, status: patch.status };
}

/** Update qty diterima setelah GRN diposting — idempotent per grn.id + optimistic concurrency. */
export async function syncCpoOnGrnPosted(db: Db, grn: JsonObject) {
  if (!grn?.noPO) return { action: 'skipped' };
  const grnId = String(grn.id || '').trim();
  if (!grnId) return { action: 'skipped', reason: 'missing_grn_id' };

  const lookup = { tenantId: grn.tenantId, noPO: grn.noPO };
  const grnItems = Array.isArray(grn.items) ? grn.items as JsonObject[] : [];

  for (let attempt = 0; attempt < QTY_SYNC_RETRIES; attempt++) {
    const po = await db.collection('customer_purchase_orders').findOne(lookup) as CpoDoc | null;
    if (!po) return { action: 'not_found' };
    if (hasAppliedId(po.appliedReceiveGrnIds, grnId)) {
      return { action: 'skipped', reason: 'already_applied', grnId, poId: po.id };
    }

    const ver = Number(po.qtySyncVersion) || 0;
    const usedGrn = new Set<number>();
    const items = (po.items || []).map((line) => {
      const recv = findMatchingGrnLine(line as LocalPoLineLike, grnItems, usedGrn);
      const add = parseFloat(String(recv?.qtyReceived)) || 0;
      return { ...line, qtyReceived: (Number(line.qtyReceived) || 0) + add };
    });

    const receiveStatus = rollupReceiveStatus(items);
    const keepInvoiced = String(po.status || '') === 'INVOICED';
    const status = keepInvoiced ? po.status : receiveStatus;

    const result = await db.collection('customer_purchase_orders').updateOne(
      qtySyncVersionFilter(String(po.id), ver, { appliedReceiveGrnIds: { $ne: grnId } }),
      {
        $set: {
          items,
          status,
          receivedAt: new Date(),
          updatedAt: new Date(),
          qtySyncVersion: ver + 1,
        },
        $addToSet: { appliedReceiveGrnIds: grnId },
      },
    );
    if (result.matchedCount > 0) {
      return { action: 'updated', poId: po.id, status };
    }
  }
  return { action: 'skipped', reason: 'concurrent_conflict', grnId };
}
