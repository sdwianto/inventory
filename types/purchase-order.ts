import type { JsonObject } from '@/types/json';

/** Saluran PO: vendor = sales.app (default), local = supplier manual (fase mendatang). */
export type PoChannel = 'VENDOR' | 'LOCAL';

export const PO_CHANNEL_VENDOR: PoChannel = 'VENDOR';
export const PO_CHANNEL_LOCAL: PoChannel = 'LOCAL';

/** Status alur PO lokal — mirip vendor PO, tanpa sync ke sales.app. */
export type LocalPoStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'ORDERED'
  | 'PARTIAL_RECEIVED'
  | 'RECEIVED'
  | 'INVOICED'
  | 'CLOSED'
  | 'REJECTED'
  | 'CANCELLED';

export type LocalPoItem = JsonObject & {
  kode?: string;
  nama?: string;
  satuan?: string;
  qty?: number;
  hargaSatuan?: number;
  subtotal?: number;
};

/** Dokumen PO lokal — koleksi `local_purchase_orders` (belum diaktifkan penuh). */
export type LocalPurchaseOrderDoc = JsonObject & {
  id?: string;
  tenantId?: string;
  poChannel?: PoChannel;
  noPO?: string;
  status?: LocalPoStatus;
  supplierName?: string;
  supplierContact?: string;
  items?: LocalPoItem[];
  estimasiTotal?: number;
  catatan?: string;
  /** Link ke modul maintenance (fase mendatang). */
  maintenanceRequestId?: string | null;
  assetId?: string | null;
};

/** Field opsional di PO vendor untuk link maintenance / pelacakan saluran. */
export type VendorPurchaseOrderDoc = JsonObject & {
  poChannel?: PoChannel;
  maintenanceRequestId?: string | null;
  assetId?: string | null;
};
