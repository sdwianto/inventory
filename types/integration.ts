import type { JsonObject } from '@/types/json';

/** Invoice line from sales.app webhook payload. */
export interface VendorInvoiceLine {
  lineId?: string;
  stokId?: string;
  uomId?: string;
  satuan?: string;
  kode?: string;
  qty?: number | string;
  qtyBase?: number | string;
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
  vendorCompanyName?: string;
  vendorAddress?: string;
  vendorPhone?: string;
  vendorNPWP?: string;
  vendorLogoBase64?: string;
  /** Warna brand dokumen vendor (hex #RRGGBB) — header tabel Faktur Tagihan. */
  vendorWarnaBrand?: string;
  vendorInvoiceReportId?: string;
  vendor?: {
    companyName?: string;
    companyAddress?: string;
    companyPhone?: string;
    companyNPWP?: string;
    logoBase64?: string;
    warnaBrand?: string;
    invoiceReportId?: string;
    showLogoOnInvoice?: boolean;
  };
  pelangganName?: string;
  customerName?: string;
  userName?: string;
  vendorTenantId?: string;
  items?: VendorInvoiceLine[];
}

export interface ThreeWayMatchOptions {
  qtyTolerancePct?: number;
  priceTolerancePct?: number;
  /** Baris invoice hutang lain (belum REJECTED) yang sudah menagih GRN yang sama — untuk deteksi duplikat. */
  siblingInvoices?: { noInvoice?: string; items?: VendorInvoiceLine[] }[];
  /** hutang.id yang sedang disinkron ulang — dikecualikan saat query sibling supaya tidak menandai dirinya sendiri. */
  excludeHutangId?: string;
}

export interface ThreeWayMatchResult {
  ok: boolean;
  error?: string;
  code?: string;
  grnCount?: number;
  grnValue?: number;
  invoiceTotal?: number;
}
