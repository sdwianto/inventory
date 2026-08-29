import { getVariantById, listVariants } from './catalog';
import type { DocumentKind, DocumentVariant } from './types';
import { DEFAULT_DELIVERY_REPORT_ID, DEFAULT_INVOICE_REPORT_ID } from './types';

export function normalizeDeliveryReportId(id: string | null | undefined): string {
  const found = getVariantById(id);
  return found?.kind === 'delivery' ? found.id : DEFAULT_DELIVERY_REPORT_ID;
}

export function normalizeInvoiceReportId(id: string | null | undefined): string {
  const found = getVariantById(id);
  return found?.kind === 'invoice' ? found.id : DEFAULT_INVOICE_REPORT_ID;
}

export function resolveDocumentVariant(
  kind: DocumentKind,
  settings: unknown,
): DocumentVariant {
  const s = settings as { deliveryReportId?: string; invoiceReportId?: string } | null | undefined;
  const id = kind === 'delivery'
    ? normalizeDeliveryReportId(s?.deliveryReportId)
    : normalizeInvoiceReportId(s?.invoiceReportId);
  return getVariantById(id) || listVariants(kind)[0];
}

export function resolveInvoiceVariantFromVendor(vendor: unknown): DocumentVariant {
  const src = vendor as {
    invoiceReportId?: string;
    vendorInvoiceReportId?: string;
  } | null | undefined;
  return resolveDocumentVariant('invoice', {
    invoiceReportId: src?.invoiceReportId || src?.vendorInvoiceReportId,
  });
}
