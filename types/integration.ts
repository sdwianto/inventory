import type { JsonObject } from '@/types/json';

/** Invoice line from sales.app webhook payload. */
export interface VendorInvoiceLine {
  kode?: string;
  qty?: number | string;
  harga?: number | string;
  nama?: string;
}

/** Invoice payload from sales.app `invoice.posted` webhook. */
export interface VendorInvoicePayload extends JsonObject {
  invoiceId?: string;
  noInvoice?: string;
  noDO?: string;
  noSO?: string | null;
  noPO?: string | null;
  deliveryId?: string;
  salesOrderId?: string;
  salesOrderTotal?: number | string;
  salesOrderSubTotal?: number | string;
  total?: number | string;
  subTotal?: number | string;
  ppn?: number | string;
  paymentTerms?: string;
  jatuhTempo?: string | Date;
  postedAt?: string | Date;
  vendorName?: string;
  pelangganName?: string;
  customerName?: string;
  userName?: string;
  vendorTenantId?: string;
  items?: VendorInvoiceLine[];
}

export interface ThreeWayMatchOptions {
  qtyTolerancePct?: number;
  priceTolerancePct?: number;
}

export interface ThreeWayMatchResult {
  ok: boolean;
  error?: string;
  code?: string;
  grnCount?: number;
  grnValue?: number;
  invoiceTotal?: number;
}
