/** Vendor Return (RTV) — Inventory orchestrator document. */

export const VENDOR_RETURNS_COLLECTION = 'vendor_returns';

export type VendorReturnStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'POSTING' | 'POSTED';
export type VendorReturnCnSyncStatus = 'NONE' | 'SYNCING' | 'DONE' | 'FAILED' | 'SKIPPED';
/** Keputusan vendor per baris (ADR-006). Dokumen-level `VendorReturnVendorDecision` = agregat dari semua baris. */
export type VendorReturnLineDecision = 'PENDING' | 'ACCEPTED' | 'REJECTED';
/** Agregat: PENDING (belum ada keputusan), PARTIAL (campuran), ACCEPTED/REJECTED (semua baris sama), NONE (tidak pernah disinkron ke sales). */
export type VendorReturnVendorDecision = 'NONE' | 'PENDING' | 'PARTIAL' | 'ACCEPTED' | 'REJECTED';

export type VendorReturnActor = {
  userId?: string;
  userName?: string;
  role?: string;
};

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
  /**
   * Stok baris sudah di-IN kembali setelah vendor REJECTED.
   * Idempotensi non-TX / replay: jangan restore ulang kalau sudah terisi.
   */
  stockRestoredAt?: Date | null;
  /** Jurnal reverse transit (Dr Persediaan / Cr Barang dalam retur) sudah ada untuk baris ini. */
  transitRestoredAt?: Date | null;
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
  /**
   * FEFO lot consume per baris saat Post (mirror Issue `fefoConsume`).
   * Dipakai restore stok lot saat vendor REJECTED (ADR-006 D5).
   */
  lotConsume?: Array<{
    lineId: string;
    invoiceLineId?: string | null;
    localStokId: string;
    warehouseKode: string;
    needQty: number;
    allocated: number;
    shortfall: number;
    skippedNoLots: boolean;
    allocations: Array<{
      batchId: string;
      batchNo?: string;
      expiryDate: string;
      qty: number;
    }>;
  }>;
  creditNoteId?: string | null;
  noCN?: string | null;
  cnSyncStatus: VendorReturnCnSyncStatus;
  cnSyncError?: string | null;
  cnSyncAt?: Date | null;
  /** SoD — diajukan untuk approval sebelum post stok/CN. */
  submittedAt?: Date | null;
  submittedBy?: VendorReturnActor | null;
  approvedAt?: Date | null;
  approvedBy?: VendorReturnActor | null;
  approvalRejectReason?: string | null;
  postedAt?: Date | null;
  postedBy?: { userId?: string; userName?: string } | null;
  /**
   * Stok OUT sudah diterapkan (meski status masih PENDING_APPROVAL setelah gagal non-TX / stuck sweep).
   * Approve ulang tidak boleh OUT kedua kali.
   */
  stockAppliedAt?: Date | null;
  /**
   * ADR-005 — jurnal transit Post (Dr Barang dalam retur / Cr Persediaan).
   * CN accept clear transit; reject restore Persediaan. Legacy tanpa flag → CN tetap Cr Persediaan.
   */
  transitJournalId?: string | null;
  transitAmount?: number | null;
  transitAppliedAt?: Date | null;
  /** Agregat dari items[].vendorDecision — dihitung, bukan disetel manual per keputusan. */
  vendorDecision?: VendorReturnVendorDecision;
  vendorDecisionAt?: Date | null;
  vendorDecisionBy?: { userId?: string; userName?: string; tenantId?: string } | null;
  /** +7 hari dari postedAt — dipakai untuk highlight "lewat tenggat", bukan auto-aksi (ADR-006). */
  vendorDecisionDueAt?: Date | null;
  /** Diisi setelah buyer membuat CPO pengganti dari baris yang diterima vendor. */
  replacementCpoId?: string | null;
  replacementCpoNo?: string | null;
  replacementCpoAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: VendorReturnActor;
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
