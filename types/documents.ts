import type { JsonObject } from '@/types/json';

export type HutangDoc = JsonObject & {
  id?: string;
  tenantId?: string;
  total?: number;
  terbayar?: number;
  sisa?: number;
  approvalStatus?: string;
  status?: string;
  referenceType?: string;
  vendorInvoiceId?: string;
  noInvoice?: string;
  noHutang?: string;
  noDO?: string;
  noPO?: string;
  noSO?: string;
  salesOrderId?: string;
  vendorTenantId?: string;
  customerPoId?: string | null;
  poEstimasiTotal?: number;
  soTotal?: number;
  soSubTotal?: number;
  salesOrderTotal?: number;
  salesOrderSubTotal?: number;
  varianceSoToInvoice?: number;
  variancePoToSo?: number;
  grnReceivedTotal?: number;
  matchStatus?: string;
  matchError?: string;
  paidExternalAt?: Date | string;
  paidExternalBy?: JsonObject;
  approvedAt?: Date | string;
  approvedBy?: JsonObject;
};

export type GrnDoc = JsonObject & {
  id?: string;
  tenantId?: string;
  status?: string;
  noDO?: string;
  noGRN?: string;
  noInvoice?: string | null;
  noSO?: string;
  noPO?: string;
  hutangId?: string | null;
  vendorInvoiceId?: string;
  vendorDeliveryId?: string;
  vendorTenantId?: string;
  receivedTotal?: number | string;
  postedAt?: Date | string;
  items?: JsonObject[];
};

export interface SalesReplayOptions {
  fullSync?: boolean;
  salesDoSet?: Set<string> | null;
}

export interface ReconcileOptions {
  callSales?: boolean;
  salesDoSet?: Set<string> | null;
}

export interface SalesErrorRow {
  noDO?: unknown;
  noGRN?: unknown;
  error: string;
}
