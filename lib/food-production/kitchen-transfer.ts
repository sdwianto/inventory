/**
 * Kitchen Transfer / Central → Satellite distribution — ADR-001 Phase 4.
 * Stock moves when warehouses differ; allocation-only when same warehouse.
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import { FP_DEFAULT_TRANSITIONS } from '@/lib/food-production/document';
import { roundQty } from '@/lib/food-production/material-requirement';

export const KITCHEN_TRANSFERS_COLLECTION = 'kitchen_transfers';

export type KitchenTransferStatus = FpDocStatus;

export interface KitchenTransferLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qty: number;
}

export interface KitchenTransferDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  tanggal: string;
  fromKitchenId: string;
  fromKitchenNama?: string;
  fromWarehouseKode: string;
  toKitchenId: string;
  toKitchenNama?: string;
  toWarehouseKode: string;
  /** True when both kitchens share warehouse — no stock post. */
  allocationOnly: boolean;
  productionPlanId?: string;
  productionPlanNo?: string;
  lines: KitchenTransferLine[];
  status: KitchenTransferStatus;
  history: DocHistoryEntry[];
  summary: {
    lineCount: number;
    qtyTotal: number;
  };
  stockPostedAt?: Date;
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

export const XFER_STATUS_TRANSITIONS: Record<string, string[]> = {
  ...FP_DEFAULT_TRANSITIONS,
  APPROVED: ['PROCESSING', 'COMPLETED', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
};

export const XFER_STATUS_LABELS: Record<KitchenTransferStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Diajukan',
  APPROVED: 'Disetujui',
  PROCESSING: 'Diproses',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};

export const XFER_UI_STATUS_NEXT: Partial<Record<KitchenTransferStatus, KitchenTransferStatus>> = {
  DRAFT: 'SUBMITTED',
  SUBMITTED: 'APPROVED',
  APPROVED: 'COMPLETED',
  PROCESSING: 'COMPLETED',
};

export function isXferEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

export function normalizeXferLines(raw: unknown): KitchenTransferLine[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Minimal satu baris transfer' };
  const out: KitchenTransferLine[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown>;
    const productId = String(row.productId || '').trim();
    const qty = Number(row.qty);
    if (!productId) return { error: `Baris ${i + 1}: productId wajib` };
    if (!Number.isFinite(qty) || qty <= 0) return { error: `Baris ${i + 1}: qty harus > 0` };
    if (seen.has(productId)) return { error: `Produk duplikat pada baris ${i + 1}` };
    seen.add(productId);
    out.push({
      productId,
      productKode: row.productKode != null ? String(row.productKode) : undefined,
      productNama: row.productNama != null ? String(row.productNama) : undefined,
      satuan: row.satuan != null ? String(row.satuan) : undefined,
      qty: roundQty(qty),
    });
  }
  return out;
}

export function summarizeXferLines(lines: KitchenTransferLine[]) {
  return {
    lineCount: lines.length,
    qtyTotal: roundQty(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)),
  };
}

export function assertKitchenTransferPair(input: {
  fromKitchenId: string;
  toKitchenId: string;
  fromWarehouseKode: string;
  toWarehouseKode: string;
}): { error: string } | { allocationOnly: boolean } {
  if (!input.fromKitchenId || !input.toKitchenId) {
    return { error: 'Dapur asal dan tujuan wajib' };
  }
  if (input.fromKitchenId === input.toKitchenId) {
    return { error: 'Dapur asal dan tujuan tidak boleh sama' };
  }
  const allocationOnly = input.fromWarehouseKode === input.toWarehouseKode;
  return { allocationOnly };
}
