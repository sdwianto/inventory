/** Vendor Return (RTV) — Inventory orchestrator document. */

export const VENDOR_RETURNS_COLLECTION = 'vendor_returns';

export type VendorReturnStatus = 'DRAFT' | 'POSTING' | 'POSTED';
export type VendorReturnCnSyncStatus = 'NONE' | 'SYNCING' | 'DONE' | 'FAILED' | 'SKIPPED';

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
  createdAt: Date;
  updatedAt: Date;
  createdBy?: { userId?: string; userName?: string };
};

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
