/**
 * Purchase Requirement (PRB) — ADR-001 Sprint 5.
 * From MRP net shortages → purchase lines → Draft CPO.
 */

import type { DocHistoryEntry, FpDocStatus } from '@/lib/food-production/document';
import type { MaterialRequirementLine } from '@/lib/food-production/material-requirement';

export const PURCHASE_REQUIREMENTS_COLLECTION = 'purchase_requirements';

export type PurchaseRequirementStatus = FpDocStatus;

export interface PurchaseRequirementLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qtyNet: number;
  qtyGross?: number;
  qtyOnHand?: number;
}

export interface PurchaseRequirementDoc {
  id: string;
  tenantId: string;
  noDokumen: string;
  materialRequirementId: string;
  materialRequirementNo?: string;
  productionPlanId: string;
  productionPlanNo?: string;
  tanggal: string;
  kitchenId?: string;
  kitchenNama?: string;
  warehouseKode?: string;
  lines: PurchaseRequirementLine[];
  status: PurchaseRequirementStatus;
  history: DocHistoryEntry[];
  summary: {
    lineCount: number;
    qtyNetTotal: number;
    /** Soft warnings (e.g. produk tanpa vendor sync). */
    warnings?: string[];
  };
  draftCpoId?: string;
  draftCpoNo?: string;
  /** Enriched at read-time from customer_purchase_orders. */
  draftCpoStatus?: string;
  catatan?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  createdByName?: string;
}

/** MRP statuses eligible to generate Purchase Requirement. */
export const PR_ELIGIBLE_MRP_STATUSES = new Set(['APPROVED']);

/** PR still in flight — only one allowed per MRP. */
export const PR_ACTIVE_STATUSES = ['SUBMITTED', 'APPROVED', 'PROCESSING'] as const;

export function isPrEditable(status: string): boolean {
  return status === 'DRAFT' || status === 'SUBMITTED';
}

/** Linked Draft CPO can be recreated when missing or cancelled. */
export function canRecreateDraftCpo(
  prStatus: string,
  draftCpoStatus?: string | null,
): boolean {
  if (prStatus === 'CANCELLED' || prStatus === 'COMPLETED') return false;
  if (!draftCpoStatus) return true;
  return draftCpoStatus === 'CANCELLED' || draftCpoStatus === 'MISSING';
}

/** Prior PR's linked CPO may be superseded (cancelled) only if not already in flight. */
export function isLinkedCpoSupersedable(status?: string | null): boolean {
  if (!status || status === 'MISSING') return true;
  return status === 'DRAFT' || status === 'CANCELLED';
}

/** Pure: shortage lines from MRP → PR lines (qtyNet > 0, finite). */
export function buildPurchaseLinesFromMrp(
  mrpLines: Pick<
    MaterialRequirementLine,
    'productId' | 'productKode' | 'productNama' | 'satuan' | 'qtyNet' | 'qtyGross' | 'qtyOnHand' | 'shortage'
  >[],
): PurchaseRequirementLine[] {
  return (mrpLines || [])
    .filter((l) => {
      const qty = Number(l.qtyNet);
      return (
        l.shortage
        && Number.isFinite(qty)
        && qty > 0
        && String(l.productId || '').trim()
      );
    })
    .map((l) => ({
      productId: String(l.productId).trim(),
      productKode: l.productKode,
      productNama: l.productNama,
      satuan: l.satuan,
      qtyNet: Number(l.qtyNet),
      qtyGross: l.qtyGross != null && Number.isFinite(Number(l.qtyGross))
        ? Number(l.qtyGross)
        : undefined,
      qtyOnHand: l.qtyOnHand != null && Number.isFinite(Number(l.qtyOnHand))
        ? Number(l.qtyOnHand)
        : undefined,
    }))
    .sort((a, b) =>
      String(a.productNama || a.productKode || a.productId).localeCompare(
        String(b.productNama || b.productKode || b.productId),
        'id',
      ),
    );
}

export function summarizePurchaseLines(lines: PurchaseRequirementLine[]): PurchaseRequirementDoc['summary'] {
  return {
    lineCount: lines.length,
    qtyNetTotal: lines.reduce((s, l) => s + (Number(l.qtyNet) || 0), 0),
  };
}

/** Map PR lines to raw CPO item payloads (localStokId = productId). */
export function toDraftCpoItemPayloads(lines: PurchaseRequirementLine[]): Array<{
  localStokId: string;
  qty: number;
  satuan?: string;
  nama?: string;
  kode?: string;
  estimasiHarga: number;
}> {
  return lines.map((l) => ({
    localStokId: l.productId,
    qty: l.qtyNet,
    satuan: l.satuan,
    nama: l.productNama,
    kode: l.productKode,
    estimasiHarga: 0,
  }));
}

export const PR_STATUS_LABELS: Record<PurchaseRequirementStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Diajukan',
  APPROVED: 'Disetujui',
  PROCESSING: 'Diproses',
  COMPLETED: 'Selesai',
  CANCELLED: 'Dibatalkan',
};
