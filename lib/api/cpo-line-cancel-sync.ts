// Sinkron pembatalan baris SO (sales.app) → baris PO customer (inventory).

import { buildVendorSoSnapshot } from '@/lib/api/vendor-so-snapshot';
import { findMatchingVendorWebhookLine, type LocalPoLineLike } from '@/lib/uom/match-vendor-line';
import type { JsonObject } from '@/types/json';

export type CpoLineCancelRecord = {
  lineId?: string;
  kode?: string;
  nama?: string;
  qty?: number;
  reason?: string;
  cancelledAt?: Date | string;
  salesOrderId?: string;
  noSO?: string;
};

type CpoLine = JsonObject & {
  lineId?: string;
  kode?: string;
  vendorKode?: string;
  nama?: string;
  qty?: number | string;
  cancelled?: boolean;
  qtyCancelled?: number;
  qtyOriginal?: number;
  cancelledAt?: Date | string;
  cancelReason?: string;
  cancelledSource?: string;
};

function parseQty(v: unknown): number {
  return parseFloat(String(v ?? 0)) || 0;
}

function lineKode(line: { kode?: string; vendorKode?: string }): string {
  return String(line.vendorKode || line.kode || '').trim().toUpperCase();
}

function matchesCancelRecord(line: CpoLine, record: CpoLineCancelRecord): boolean {
  if (record.lineId && line.lineId && String(record.lineId) === String(line.lineId)) return true;
  const lk = lineKode(line);
  const rk = lineKode({ kode: record.kode });
  return !!lk && !!rk && lk === rk;
}

function markLineCancelled(
  line: CpoLine,
  record: CpoLineCancelRecord,
  now: Date,
): CpoLine {
  const origQty = parseQty(line.qtyOriginal ?? line.qty);
  return {
    ...line,
    cancelled: true,
    qtyOriginal: origQty,
    qtyCancelled: record.qty != null ? parseQty(record.qty) : origQty,
    cancelledAt: record.cancelledAt ? new Date(String(record.cancelledAt)) : now,
    cancelReason: record.reason || line.cancelReason || 'Dibatalkan di sales.app',
    cancelledSource: 'sales.app',
  };
}

function appendCancelAudit(
  existing: JsonObject[] | undefined,
  record: CpoLineCancelRecord,
  now: Date,
): JsonObject[] {
  const prev = Array.isArray(existing) ? [...existing] : [];
  const key = `${record.lineId || ''}:${record.kode || ''}:${record.cancelledAt || now.toISOString()}`;
  if (prev.some((r) => `${r.lineId || ''}:${r.kode || ''}:${r.cancelledAt || ''}` === key)) return prev;
  prev.push({
    lineId: record.lineId,
    kode: record.kode,
    nama: record.nama,
    qty: record.qty,
    reason: record.reason,
    cancelledAt: record.cancelledAt ? new Date(String(record.cancelledAt)) : now,
    salesOrderId: record.salesOrderId,
    noSO: record.noSO,
  });
  return prev;
}

/** Terapkan baris cancel eksplisit dari webhook sales.app. */
export function applyCancelledLinesToPoItems(
  poItems: CpoLine[],
  cancelledLines: CpoLineCancelRecord[],
  meta: { salesOrderId?: string; noSO?: string },
  now = new Date(),
): CpoLine[] {
  if (!cancelledLines.length) return poItems;
  return poItems.map((line) => {
    if (line.cancelled) return line;
    const record = cancelledLines.find((c) => matchesCancelRecord(line, c));
    if (!record) return line;
    return markLineCancelled(line, { ...record, ...meta }, now);
  });
}

/** Bandingkan baris PO dengan item aktif di SO — yang hilang ditandai dibatalkan. */
export function diffPoItemsAgainstActiveSo(
  poItems: CpoLine[],
  activeSoItems: JsonObject[],
  meta: { salesOrderId?: string; noSO?: string },
  now = new Date(),
): CpoLine[] {
  if (!activeSoItems.length) return poItems;

  return poItems.map((line) => {
    if (line.cancelled) return line;
    const matched = findMatchingVendorWebhookLine(
      line as LocalPoLineLike,
      activeSoItems as Parameters<typeof findMatchingVendorWebhookLine>[1],
    );
    if (matched) return line;
    return markLineCancelled(line, {
      kode: line.kode ? String(line.kode) : undefined,
      nama: line.nama ? String(line.nama) : undefined,
      qty: parseQty(line.qty),
      reason: 'Tidak ada di SO sales.app',
      ...meta,
    }, now);
  });
}

function rollupPartialCancelStatus(items: CpoLine[], currentStatus?: string): string | undefined {
  const active = items.filter((l) => !l.cancelled);
  const cancelled = items.filter((l) => l.cancelled);
  if (!cancelled.length) return currentStatus;
  if (!active.length) return 'CANCELLED';
  if (['SUBMITTED', 'CONFIRMED', 'PARTIAL_SHIPPED', 'SHIPPED'].includes(String(currentStatus || ''))) {
    return 'PARTIAL_CANCELLED';
  }
  return currentStatus;
}

/** Sinkron payload webhook SO (updated/confirmed) ke dokumen PO. */
export function syncCpoFromSoPayload(
  po: JsonObject,
  payload: Record<string, unknown>,
  now = new Date(),
): {
  items: CpoLine[];
  vendorSoSnapshot?: ReturnType<typeof buildVendorSoSnapshot>;
  cancelledSoLines?: JsonObject[];
  status?: string;
} {
  const poItems = (Array.isArray(po.items) ? [...po.items] : []) as CpoLine[];
  const meta = {
    salesOrderId: String(payload.salesOrderId || po.vendorSoId || ''),
    noSO: String(payload.noSO || po.vendorNoSO || ''),
  };

  const cancelledRaw = [
    ...(Array.isArray(payload.cancelledLines) ? payload.cancelledLines : []),
    ...(Array.isArray(payload.cancelledItems) ? payload.cancelledItems : []),
    ...(payload.cancelledLine && typeof payload.cancelledLine === 'object' ? [payload.cancelledLine] : []),
  ] as CpoLineCancelRecord[];

  let items = poItems;
  if (cancelledRaw.length) {
    items = applyCancelledLinesToPoItems(items, cancelledRaw, meta, now);
  }

  const activeItems = Array.isArray(payload.items) ? payload.items as JsonObject[] : [];
  if (activeItems.length) {
    items = diffPoItemsAgainstActiveSo(items, activeItems, meta, now);
  }

  const soSnap = buildVendorSoSnapshot(payload);
  let cancelledSoLines = po.cancelledSoLines as JsonObject[] | undefined;
  for (const record of cancelledRaw) {
    cancelledSoLines = appendCancelAudit(cancelledSoLines, { ...record, ...meta }, now);
  }

  const status = rollupPartialCancelStatus(items, String(po.status || ''));

  return {
    items,
    ...(soSnap ? { vendorSoSnapshot: soSnap } : {}),
    ...(cancelledSoLines?.length ? { cancelledSoLines } : {}),
    ...(status && status !== po.status ? { status } : {}),
  };
}

/** Enrich PO untuk tampilan — diff snapshot jika belum ada flag cancel. */
export function enrichPoItemsForDisplay(po: JsonObject): JsonObject[] {
  const items = (Array.isArray(po.items) ? po.items : []) as CpoLine[];
  if (items.some((l) => l.cancelled)) return items;

  const snap = po.vendorSoSnapshot as JsonObject | undefined;
  const activeItems = Array.isArray(snap?.items) ? snap.items as JsonObject[] : [];
  if (!activeItems.length || items.length <= activeItems.length) return items;

  const meta = {
    salesOrderId: String(po.vendorSoId || ''),
    noSO: String(po.vendorNoSO || ''),
  };
  return diffPoItemsAgainstActiveSo(items, activeItems, meta);
}
