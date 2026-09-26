import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
// Sinkron status Customer PO dari webhook vendor (sales.app).

import { syncCpoFromSoPayload, applySoCancelledWebhookToPoItems } from '@/lib/api/cpo-line-cancel-sync';
import { findMatchingGrnLine, findMatchingVendorWebhookLine, type LocalPoLineLike } from '@/lib/uom/match-vendor-line';
import { logger } from '@/lib/api/logger';
import { resolveLineQtyBase } from '@/lib/uom/resolve-line-qty';
import { roundQty } from '@/lib/stock-ledger/precision';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import type { JsonObject } from '@/types/json';
import { procurementLineKey } from '@/lib/food-production/procurement-line-key';

export type CpoLine = JsonObject & {
  localStokId?: string;
  kode?: string;
  vendorKode?: string;
  satuan?: string;
  uomId?: string;
  qty?: number | string;
  qtyShipped?: number;
  qtyReceived?: number;
  qtyRejected?: number;
  /** Sisa backorder yang ditutup (short-close) dalam satuan baris PO. */
  qtyShortClosed?: number;
  cancelled?: boolean;
};

function lineShortClosedQty(line: CpoLine): number {
  return Math.max(0, parseFloat(String(line.qtyShortClosed)) || 0);
}

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
  appliedReverseGrnIds?: string[];
  qtySyncVersion?: number;
};

const QTY_SYNC_RETRIES = 8;

function normUnitText(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

/**
 * Qty baris GRN dalam satuan baris PO. Satuan sama → apa adanya; beda satuan → lewat qty dasar
 * (faktor satuan PO dari product_uom). Tidak terkonversi → null (qty PO tidak diubah, dicatat log).
 */
export async function grnQtyInPoUnit(
  db: Db,
  tenantId: string,
  poLine: JsonObject,
  recv: JsonObject | undefined,
  uomsCache: Map<string, import('@/lib/uom/types').ProductUom[]>,
): Promise<{ received: number; rejected: number } | null> {
  const received = parseFloat(String(recv?.qtyReceived)) || 0;
  const rejected = parseFloat(String(recv?.qtyRejected)) || 0;
  if (!recv || (!(received > 0) && !(rejected > 0))) return { received, rejected };
  const poUom = String(poLine.uomId ?? '').trim();
  const grnUom = String(recv.uomId ?? '').trim();
  const poHasUnit = Boolean(poUom || normUnitText(poLine.satuan));
  const grnHasUnit = Boolean(grnUom || normUnitText(recv.satuan));
  const sameUnit = !poHasUnit || !grnHasUnit
    || (poUom && grnUom && poUom === grnUom)
    || (normUnitText(poLine.satuan) && normUnitText(poLine.satuan) === normUnitText(recv.satuan));
  if (sameUnit) return { received, rejected };

  const productId = String(poLine.localStokId || '').trim();
  const receivedBase = parseFloat(String(recv.qtyReceivedBase));
  if (!productId || !(received > 0 ? Number.isFinite(receivedBase) : true)) return null;
  const poFactor = await resolveLineQtyBase(db, tenantId, productId, {
    qty: 1,
    uomId: poUom || undefined,
    satuan: poLine.satuan ? String(poLine.satuan) : undefined,
  }, uomsCache);
  if ('error' in poFactor || !(poFactor.qtyBase > 0)) return null;
  const grnFactor = received > 0 ? receivedBase / received : null;
  let rejectedBase = 0;
  if (rejected > 0) {
    if (grnFactor && grnFactor > 0) {
      rejectedBase = rejected * grnFactor;
    } else {
      const grnRes = await resolveLineQtyBase(db, tenantId, String(recv.localStokId || productId), {
        qty: rejected,
        uomId: grnUom || undefined,
        satuan: recv.satuan ? String(recv.satuan) : undefined,
      }, uomsCache);
      if ('error' in grnRes) return null;
      rejectedBase = grnRes.qtyBase;
    }
  }
  return {
    received: roundQty((received > 0 ? receivedBase : 0) / poFactor.qtyBase),
    rejected: roundQty(rejectedBase / poFactor.qtyBase),
  };
}

function findCpoFilter(tenantId: string, payload: Record<string, unknown>) {
  const base = { tenantId };
  if (payload.customerPoId) return { ...base, id: payload.customerPoId };
  if (payload.noPO) return { ...base, noPO: payload.noPO };
  if (payload.salesOrderId) return { ...base, vendorSoId: payload.salesOrderId };
  if (payload.noSO) return { ...base, vendorNoSO: payload.noSO };
  return null;
}

export function lineQtyTarget(line: CpoLine): number {
  if (line.cancelled) return 0;
  const qty = parseFloat(String(line.qty)) || 0;
  const rejected = parseFloat(String(line.qtyRejected)) || 0;
  return Math.max(0, qty - rejected - lineShortClosedQty(line));
}

/**
 * qtyOrdered/qtyReceived per produk, dari baris PO yang MASIH aktif memasok
 * (bukan dibatalkan — mis. "Tidak ada di SO sales.app"). Baris dibatalkan
 * TIDAK dimasukkan sama sekali ke map, supaya caller (acuan kesiapan
 * produksi) jatuh balik ke resep-vs-stok untuk produk itu, bukan menganggap
 * kebutuhannya nol — PO dibatalkan berarti PO tidak lagi memasok, bukan
 * berarti bahan itu sudah tidak dibutuhkan.
 */
export function buildPoOrderedReceivedMap(
  items: CpoLine[],
): Map<string, { qtyOrdered: number; qtyReceived: number }> {
  const map = new Map<string, { qtyOrdered: number; qtyReceived: number }>();
  const add = (key: string, qtyOrdered: number, qtyReceived: number) => {
    if (!key) return;
    const prev = map.get(key) || { qtyOrdered: 0, qtyReceived: 0 };
    map.set(key, {
      qtyOrdered: prev.qtyOrdered + qtyOrdered,
      qtyReceived: prev.qtyReceived + qtyReceived,
    });
  };
  for (const item of items || []) {
    if (!item.localStokId || item.cancelled) continue;
    const qtyOrdered = lineOrderedQty(item);
    if (qtyOrdered <= 0) continue;
    const qtyReceived = Number(item.qtyReceived) || 0;
    const id = String(item.localStokId);
    add(id, qtyOrdered, qtyReceived);
    const ident = procurementLineKey({
      productId: id,
      localStokId: id,
      kode: item.kode || item.vendorKode,
      satuan: item.satuan,
      uomId: item.uomId,
    });
    if (ident !== id) add(ident, qtyOrdered, qtyReceived);
  }
  return map;
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

/** Qty pesan yang masih harus diterima baik. Penolakan tidak mengurangi target; short-close mengurangi. */
function lineOrderedQty(line: CpoLine): number {
  if (line.cancelled) return 0;
  return Math.max(0, (parseFloat(String(line.qty)) || 0) - lineShortClosedQty(line));
}

/** Qty ditolak yang belum tergantikan penerimaan berikutnya. */
export function lineBackorderQty(line: CpoLine): number {
  const open = Math.max(0, lineOrderedQty(line) - (Number(line.qtyReceived) || 0));
  const rejected = Math.max(0, parseFloat(String(line.qtyRejected)) || 0);
  return Math.min(rejected, open);
}

function rollupReceiveStatus(items: CpoLine[]) {
  const active = items.filter((it) => lineOrderedQty(it) > 0);
  if (!active.length) {
    const anyReceived = items.some((it) => (Number(it.qtyReceived) || 0) > 0);
    return anyReceived ? 'RECEIVED' : 'SHIPPED';
  }
  const allReceived = active.every((it) => (Number(it.qtyReceived) || 0) >= lineOrderedQty(it));
  const anyReceived = active.some((it) => (Number(it.qtyReceived) || 0) > 0);
  if (allReceived) return 'RECEIVED';
  if (anyReceived) return 'PARTIAL_RECEIVED';
  return 'SHIPPED';
}

/**
 * Cocokkan submission vendor mana yang dimaksud sebuah event webhook.
 * `noSO` TIDAK cukup sendirian sebagai kunci — tiap vendor tenant menomori SO
 * mereka independen (mis. semua bisa sama-sama punya "SO2608000001"), jadi
 * fallback by-noSO wajib disertai vendorTenantId supaya tidak salah tempel
 * ke submission vendor lain yang kebetulan punya nomor SO sama.
 */
function matchesVendorSubmission(
  sub: JsonObject,
  meta: { soId?: string; noSO?: string; vendorTenantId?: string },
): boolean {
  if (meta.soId && sub.vendorSoId === meta.soId) return true;
  if (meta.noSO && sub.vendorNoSO === meta.noSO) {
    if (!meta.vendorTenantId) return true;
    return sub.vendorTenantId === meta.vendorTenantId;
  }
  return false;
}

/** Gabungan rollup ship+receive — status kemajuan aktual PO berdasar data item, lepas dari event pemicu. */
export function rollupCpoProgressStatus(items: CpoLine[]): string {
  const shipStatus = rollupShipStatus(items);
  if (shipStatus !== 'SHIPPED') return shipStatus;
  return rollupReceiveStatus(items);
}

const CPO_STATUS_RANK: Record<string, number> = {
  SUBMITTED: 0,
  CONFIRMED: 1,
  PARTIAL_SHIPPED: 2,
  SHIPPED: 3,
  PARTIAL_RECEIVED: 4,
  RECEIVED: 5,
  INVOICED: 6,
};

/** Jangan biarkan event yang telat/duplikat menurunkan status yang sudah lebih maju. */
export function pickForwardCpoStatus(current: string, proposed: string): string {
  const c = CPO_STATUS_RANK[current];
  const p = CPO_STATUS_RANK[proposed];
  if (c == null || p == null) return proposed;
  return p >= c ? proposed : current;
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
        // Event confirmed bisa datang telat/duplikat setelah shipped/received
        // sudah tercatat — jangan mundurkan progres yang sudah tercapai.
        patch.status = pickForwardCpoStatus(String(po.status || ''), rollupCpoProgressStatus(soSynced.items));
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
      const matchMeta = {
        soId: String(payload.salesOrderId || ''),
        noSO: String(payload.noSO || ''),
        vendorTenantId: payload.vendorTenantId ? String(payload.vendorTenantId) : undefined,
      };
      patch.vendorSubmissions = subs.map((sub) => (
        matchesVendorSubmission(sub, matchMeta) ? { ...sub, vendorSo: payload } : sub
      ));
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
      const matchMeta = {
        soId: meta.salesOrderId,
        noSO: meta.noSO,
        vendorTenantId: payload.vendorTenantId ? String(payload.vendorTenantId) : undefined,
      };
      patch.vendorSubmissions = subs.map((sub) => (
        matchesVendorSubmission(sub, matchMeta)
          ? { ...sub, status: 'CANCELLED', cancelReason: payload.reason || payload.cancelReason, vendorSo: payload }
          : sub
      ));
    }
  } else if (event === 'invoice.posted') {
    // PO multi-vendor: jangan paksa INVOICED kalau masih ada item vendor lain
    // yang aktif (belum shipped/received) atau baru dibatalkan — ikuti rollup
    // ship/receive sebenarnya, baru INVOICED kalau semua item aktif sudah RECEIVED.
    const items = (Array.isArray(po.items) ? po.items : []) as CpoLine[];
    const progressStatus = rollupCpoProgressStatus(items);
    const proposedStatus = progressStatus === 'RECEIVED' ? 'INVOICED' : progressStatus;
    patch.status = pickForwardCpoStatus(String(po.status || ''), proposedStatus);
    patch.invoicedAt = payload.postedAt ? new Date(String(payload.postedAt)) : now;
    patch.vendorNoInvoice = payload.noInvoice || po.vendorNoInvoice;
    patch.vendorInvoiceId = payload.invoiceId || po.vendorInvoiceId;
    patch.invoiceTotal = parseInt(String(payload.total || 0), 10);
  }

  await db.collection('customer_purchase_orders').updateOne({ ...tenantIdMatchFilter(po.tenantId), id: po.id }, { $set: patch });
  return { action: 'updated', poId: po.id, noPO: po.noPO, status: patch.status };
}

/**
 * Kurangi qty diterima/ditolak PO saat GRN dibalik — idempotent per grn.id.
 * grn.id tetap di appliedReceiveGrnIds supaya efek samping posting yang telat tidak menambah lagi.
 */
export async function syncCpoOnGrnReversed(db: Db, grn: JsonObject, session?: ClientSession) {
  if (!grn?.noPO) return { action: 'skipped' as const };
  const grnId = String(grn.id || '').trim();
  if (!grnId) return { action: 'skipped' as const, reason: 'missing_grn_id' };

  const lookup = { ...tenantIdMatchFilter(grn.tenantId), noPO: grn.noPO };
  const grnItems = Array.isArray(grn.items) ? grn.items as JsonObject[] : [];

  for (let attempt = 0; attempt < QTY_SYNC_RETRIES; attempt++) {
    const po = await db.collection('customer_purchase_orders').findOne(lookup, txOpts(session)) as CpoDoc | null;
    if (!po) return { action: 'not_found' as const };
    if (hasAppliedId(po.appliedReverseGrnIds, grnId)) {
      return { action: 'skipped' as const, reason: 'already_reversed', poId: po.id };
    }
    if (!hasAppliedId(po.appliedReceiveGrnIds, grnId)) {
      return { action: 'skipped' as const, reason: 'not_applied', poId: po.id };
    }

    const ver = Number(po.qtySyncVersion) || 0;
    const usedGrn = new Set<number>();
    const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
    const items: CpoLine[] = [];
    for (const line of po.items || []) {
      const recv = findMatchingGrnLine(line as LocalPoLineLike, grnItems, usedGrn);
      const qty = await grnQtyInPoUnit(db, String(grn.tenantId || ''), line as JsonObject, recv as JsonObject | undefined, uomsCache);
      if (!qty) {
        logger.warn('cpo_grn_line_unit_unconvertible', { poId: po.id, noPO: po.noPO, grnId, lineId: line.lineId, reversal: true });
      }
      const next = {
        ...line,
        qtyReceived: Math.max(0, roundQty((Number(line.qtyReceived) || 0) - (qty?.received || 0))),
        qtyRejected: Math.max(0, roundQty((Number(line.qtyRejected) || 0) - (qty?.rejected || 0))),
      };
      items.push({ ...next, qtyBackorder: lineBackorderQty(next) });
    }

    const status = String(po.status || '') === 'INVOICED' ? po.status : rollupReceiveStatus(items);
    const result = await db.collection('customer_purchase_orders').updateOne(
      qtySyncVersionFilter(String(po.id), ver, { appliedReverseGrnIds: { $ne: grnId } }),
      {
        $set: {
          items,
          status,
          hasRejectedQty: items.some((it) => (Number(it.qtyRejected) || 0) > 0),
          hasBackorder: items.some((it) => (Number(it.qtyBackorder) || 0) > 0),
          updatedAt: new Date(),
          qtySyncVersion: ver + 1,
        },
        $addToSet: { appliedReverseGrnIds: grnId },
      },
      txOpts(session),
    );
    if (result.matchedCount > 0) return { action: 'updated' as const, poId: po.id, status };
  }
  return { action: 'skipped' as const, reason: 'concurrent_conflict' };
}

/** Update qty diterima setelah GRN diposting — idempotent per grn.id + optimistic concurrency. */
export async function syncCpoOnGrnPosted(db: Db, grn: JsonObject, session?: ClientSession) {
  if (!grn?.noPO) return { action: 'skipped' };
  const grnId = String(grn.id || '').trim();
  if (!grnId) return { action: 'skipped', reason: 'missing_grn_id' };

  const lookup = { ...tenantIdMatchFilter(grn.tenantId), noPO: grn.noPO };
  const grnItems = Array.isArray(grn.items) ? grn.items as JsonObject[] : [];

  for (let attempt = 0; attempt < QTY_SYNC_RETRIES; attempt++) {
    const po = await db.collection('customer_purchase_orders').findOne(lookup, txOpts(session)) as CpoDoc | null;
    if (!po) return { action: 'not_found' };
    if (hasAppliedId(po.appliedReceiveGrnIds, grnId)) {
      return { action: 'skipped', reason: 'already_applied', grnId, poId: po.id };
    }

    const ver = Number(po.qtySyncVersion) || 0;
    const usedGrn = new Set<number>();
    const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
    const items: CpoLine[] = [];
    const unconvertible: string[] = [];
    for (const line of po.items || []) {
      const recv = findMatchingGrnLine(line as LocalPoLineLike, grnItems, usedGrn);
      const qty = await grnQtyInPoUnit(db, String(grn.tenantId || ''), line as JsonObject, recv as JsonObject | undefined, uomsCache);
      if (!qty) {
        logger.warn('cpo_grn_line_unit_unconvertible', { poId: po.id, noPO: po.noPO, grnId, lineId: line.lineId });
        unconvertible.push(String(line.kode || line.localKode || line.nama || line.lineId || '?'));
      }
      const next = {
        ...line,
        qtyReceived: roundQty((Number(line.qtyReceived) || 0) + (qty?.received || 0)),
        qtyRejected: roundQty((Number(line.qtyRejected) || 0) + (qty?.rejected || 0)),
      };
      items.push({ ...next, qtyBackorder: lineBackorderQty(next) });
    }
    if (unconvertible.length) {
      return { action: 'skipped', reason: 'unit_unconvertible', grnId, poId: po.id, lines: unconvertible };
    }

    const unmatchedGrnItems = grnItems.filter((_, i) => !usedGrn.has(i));
    if (unmatchedGrnItems.length) {
      // Baris GRN yang tidak ketemu pasangannya di PO tidak akan menambah
      // qtyReceived mana pun — kalau ini sebetulnya milik salah satu baris
      // PO, po.status bisa nyangkut PARTIAL_RECEIVED walau barang sudah
      // diterima lengkap. Log supaya kejadian ini kelihatan, bukan senyap.
      logger.warn('cpo_grn_line_unmatched', {
        poId: po.id,
        noPO: po.noPO,
        grnId,
        tenantId: grn.tenantId,
        unmatchedCount: unmatchedGrnItems.length,
        unmatched: unmatchedGrnItems.map((g) => ({
          lineId: g.lineId,
          localKode: g.localKode,
          vendorKode: g.vendorKode,
          uomId: g.uomId,
          satuan: g.satuan,
          qtyReceived: g.qtyReceived,
        })),
      });
    }

    const receiveStatus = rollupReceiveStatus(items);
    const keepInvoiced = String(po.status || '') === 'INVOICED';
    const status = keepInvoiced ? po.status : receiveStatus;
    // Informasional saja — tidak memengaruhi rollup status, hanya penanda untuk UI bahwa
    // status "selesai diterima" ini menyembunyikan kekurangan akibat item ditolak vendor.
    const hasRejectedQty = items.some((it) => (Number(it.qtyRejected) || 0) > 0);
    const hasBackorder = items.some((it) => (Number(it.qtyBackorder) || 0) > 0);

    const result = await db.collection('customer_purchase_orders').updateOne(
      qtySyncVersionFilter(String(po.id), ver, { appliedReceiveGrnIds: { $ne: grnId } }),
      {
        $set: {
          items,
          status,
          hasRejectedQty,
          hasBackorder,
          receivedAt: new Date(),
          updatedAt: new Date(),
          qtySyncVersion: ver + 1,
        },
        $addToSet: { appliedReceiveGrnIds: grnId },
      },
      txOpts(session),
    );
    if (result.matchedCount > 0) {
      return { action: 'updated', poId: po.id, status };
    }
  }
  return { action: 'skipped', reason: 'concurrent_conflict', grnId };
}
