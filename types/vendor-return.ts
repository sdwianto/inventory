/** Vendor Return (RTV) — Inventory orchestrator document. */

export const VENDOR_RETURNS_COLLECTION = 'vendor_returns';

export type VendorReturnStatus = 'DRAFT' | 'POSTING' | 'POSTED';
export type VendorReturnCnSyncStatus = 'NONE' | 'SYNCING' | 'DONE' | 'FAILED' | 'SKIPPED';
/** Keputusan vendor per baris (ADR-006). Dokumen-level `VendorReturnVendorDecision` = agregat dari semua baris. */
export type VendorReturnLineDecision = 'PENDING' | 'ACCEPTED' | 'REJECTED';
/** Agregat: PENDING (belum ada keputusan), PARTIAL (campuran), ACCEPTED/REJECTED (semua baris sama), NONE (tidak pernah disinkron ke sales). */
export type VendorReturnVendorDecision = 'NONE' | 'PENDING' | 'PARTIAL' | 'ACCEPTED' | 'REJECTED';

export type VendorReturnLine = {
  lineId: string;
  invoiceLineId?: string | null;
  grnLineId?: string | null;
  localStokId: string;
  localKode: string;
  localNama: string;
  vendorKode?: string;
  satuan: string;
  uomId?: string;
  vendorUomId?: string;
  factorToBase?: number;
  qty: number;
  qtyBase: number;
  harga: number;
  jumlah: number;
  gudangKode: string;
  lotNo?: string | null;
  maxQty?: number;
  /** Kenapa baris ini diretur (opsional) — beda dari alasan dokumen kalau diisi. */
  reason?: string | null;
  vendorDecision?: VendorReturnLineDecision;
  vendorDecisionReason?: string | null;
};

export type VendorReturnDoc = {
  id: string;
  tenantId: string;
  noReturn: string;
  status: VendorReturnStatus;
  /** Asal pembuatan RTV — `hutang` (default, dari tagihan vendor) atau `grn-reject` (dari item ditolak saat GRN). */
  source?: 'hutang' | 'grn-reject';
  vendorTenantId: string;
  supplierName?: string | null;
  hutangId?: string | null;
  vendorInvoiceId?: string | null;
  noInvoice?: string;
  noGRN?: string | null;
  grnId?: string | null;
  noDO?: string | null;
  noPO?: string | null;
  noSO?: string | null;
  reason: string;
  photos?: string[];
  items: VendorReturnLine[];
  subTotal: number;
  total: number;
  creditNoteId?: string | null;
  noCN?: string | null;
  cnSyncStatus: VendorReturnCnSyncStatus;
  cnSyncError?: string | null;
  cnSyncAt?: Date | null;
  postedAt?: Date | null;
  postedBy?: { userId?: string; userName?: string } | null;
  /** Agregat dari items[].vendorDecision — dihitung, bukan disetel manual per keputusan. */
  vendorDecision?: VendorReturnVendorDecision;
  vendorDecisionAt?: Date | null;
  vendorDecisionBy?: { userId?: string; userName?: string; tenantId?: string } | null;
  /** +7 hari dari postedAt — dipakai untuk highlight "lewat tenggat", bukan auto-aksi (ADR-006). */
  vendorDecisionDueAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: { userId?: string; userName?: string };
};

/** Agregat keputusan vendor dari baris-baris RTV — PENDING (belum ada keputusan), PARTIAL (campuran), ACCEPTED/REJECTED (semua baris sama). */
export function aggregateVendorDecision(
  items: Pick<VendorReturnLine, 'vendorDecision'>[],
): VendorReturnVendorDecision {
  if (!items.length) return 'NONE';
  const decs = items.map((it) => it.vendorDecision || 'PENDING');
  if (decs.every((d) => d === 'ACCEPTED')) return 'ACCEPTED';
  if (decs.every((d) => d === 'REJECTED')) return 'REJECTED';
  if (decs.every((d) => d === 'PENDING')) return 'PENDING';
  return 'PARTIAL';
}

export function vendorReturnLineKey(line: {
  invoiceLineId?: string | null;
  localStokId?: string;
  uomId?: string;
  satuan?: string;
}): string {
  const inv = String(line.invoiceLineId || '').trim();
  if (inv) return `inv:${inv}`;
  const stok = String(line.localStokId || '').trim();
  const uom = String(line.uomId || line.satuan || '').trim();
  return `${stok}::${uom}`;
}
