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
  vendorTenantId?: string;
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

export type DiffPoAgainstSoOpts = {
  /**
   * Jika diisi: hanya baris dengan vendorTenantId yang sama yang di-diff.
   * Baris vendor lain / tanpa vendorTenantId (mode multi) tidak diubah.
   */
  vendorTenantId?: string;
  /** true = jangan batalkan baris tanpa vendorTenantId (aman untuk PO multi-vendor). */
  onlyVendorLines?: boolean;
};

function clearAutoCancel(line: CpoLine): CpoLine {
  // Hanya pulihkan cancel otomatis dari diff SO — bukan cancel eksplisit webhook
  if (line.cancelledSource && line.cancelledSource !== 'sales.app') return line;
  if (line.cancelReason && !String(line.cancelReason).includes('Tidak ada di SO')) {
    return line;
  }
  const {
    cancelled: _c,
    qtyCancelled: _qc,
    cancelledAt: _ca,
    cancelReason: _cr,
    cancelledSource: _cs,
    ...rest
  } = line;
  if (rest.qtyOriginal != null && (rest.qty == null || parseQty(rest.qty) === 0)) {
    return { ...rest, qty: rest.qtyOriginal };
  }
  return rest;
}

/** Bandingkan baris PO dengan item aktif di SO — yang hilang ditandai dibatalkan; yang ketemu lagi dipulihkan. */
export function diffPoItemsAgainstActiveSo(
  poItems: CpoLine[],
  activeSoItems: JsonObject[],
  meta: { salesOrderId?: string; noSO?: string; vendorTenantId?: string },
  now = new Date(),
  opts?: DiffPoAgainstSoOpts,
): CpoLine[] {
  if (!activeSoItems.length) return poItems;

  const scopeVendor = String(opts?.vendorTenantId || meta.vendorTenantId || '').trim();
  const onlyVendorLines = opts?.onlyVendorLines === true;
  const usedIndices = new Set<number>();

  return poItems.map((line) => {
    if (scopeVendor) {
      const lineVendor = String(line.vendorTenantId || '').trim();
      if (lineVendor && lineVendor !== scopeVendor) return line;
      if (onlyVendorLines && lineVendor !== scopeVendor) return line;
    }

    const matched = findMatchingVendorWebhookLine(
      line as LocalPoLineLike,
      activeSoItems as Parameters<typeof findMatchingVendorWebhookLine>[1],
      usedIndices,
    );
    if (matched) {
      // Item masih di SO — pulihkan jika sebelumnya tercoret karena mismatch sync
      if (line.cancelled) return clearAutoCancel(line);
      return line;
    }
    if (line.cancelled) return line;
    return markLineCancelled(line, {
      kode: line.kode ? String(line.kode) : undefined,
      nama: line.nama ? String(line.nama) : undefined,
      qty: parseQty(line.qty),
      reason: 'Tidak ada di SO sales.app',
      ...meta,
    }, now);
  });
}

function rollupPartialCancelStatus(items: CpoLine[], currentStatus?: string): string {
  const active = items.filter((l) => !l.cancelled);
  const cancelled = items.filter((l) => l.cancelled);
  const st = String(currentStatus || '');
  if (!cancelled.length) return st || 'SUBMITTED';
  if (!active.length) return 'CANCELLED';
  if (['SUBMITTED', 'CONFIRMED', 'PARTIAL_CANCELLED', 'PARTIAL_SHIPPED', 'SHIPPED', 'CANCELLED'].includes(st)) {
    return 'PARTIAL_CANCELLED';
  }
  return st;
}

export { rollupPartialCancelStatus };

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
  const payloadVendor = String(payload.vendorTenantId || '').trim();
  if (activeItems.length) {
    items = diffPoItemsAgainstActiveSo(
      items,
      activeItems,
      { ...meta, vendorTenantId: payloadVendor || undefined },
      now,
      payloadVendor
        ? { vendorTenantId: payloadVendor, onlyVendorLines: true }
        : undefined,
    );
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
    ...(status !== po.status ? { status } : {}),
  };
}

/** Webhook sales_order.cancelled — batalkan baris terkait SO/vendor saja (bukan seluruh PO multi-vendor). */
export function applySoCancelledWebhookToPoItems(
  poItems: CpoLine[],
  payload: {
    cancelledItems?: CpoLineCancelRecord[];
    reason?: string;
    cancelReason?: string;
    vendorTenantId?: string;
  },
  meta: { salesOrderId?: string; noSO?: string },
  currentStatus: string,
  now = new Date(),
): { items: CpoLine[]; cancelledSoLines?: JsonObject[]; status: string } {
  const explicit = Array.isArray(payload.cancelledItems)
    ? payload.cancelledItems as CpoLineCancelRecord[]
    : [];
  const reason = String(payload.reason || payload.cancelReason || 'SO dibatalkan di sales.app');
  const vendor = String(payload.vendorTenantId || '').trim();

  let toApply = explicit;
  if (!explicit.length) {
    const candidates = poItems.filter((l) => !l.cancelled);
    const scoped = vendor
      ? candidates.filter((l) => String(l.vendorTenantId || '') === vendor)
      : candidates;
    toApply = scoped.map((l) => ({
      lineId: l.lineId ? String(l.lineId) : undefined,
      kode: l.kode ? String(l.kode) : undefined,
      nama: l.nama ? String(l.nama) : undefined,
      qty: parseQty(l.qtyOriginal ?? l.qty),
      reason,
    }));
  }

  const items = applyCancelledLinesToPoItems(poItems, toApply, meta, now);
  let cancelledSoLines: JsonObject[] | undefined;
  for (const record of toApply) {
    cancelledSoLines = appendCancelAudit(cancelledSoLines, { ...record, ...meta }, now);
  }
  const status = rollupPartialCancelStatus(items, currentStatus);
  return {
    items,
    ...(cancelledSoLines?.length ? { cancelledSoLines } : {}),
    status,
  };
}

/** @deprecated gunakan applySoCancelledWebhookToPoItems */
export function applyFullSoCancelToPoItems(
  poItems: CpoLine[],
  payload: { cancelledItems?: CpoLineCancelRecord[]; reason?: string; cancelReason?: string },
  meta: { salesOrderId?: string; noSO?: string },
  now = new Date(),
): { items: CpoLine[]; cancelledSoLines?: JsonObject[] } {
  const result = applySoCancelledWebhookToPoItems(poItems, payload, meta, 'SUBMITTED', now);
  return { items: result.items, ...(result.cancelledSoLines ? { cancelledSoLines: result.cancelledSoLines } : {}) };
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
