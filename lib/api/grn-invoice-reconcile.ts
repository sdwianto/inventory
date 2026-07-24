/**
 * Permanent completion path for GRN invoice sync (Fase A — no Sales job poll):
 * if Sales already has POSTED invoice for this DO, pull + create hutang → mark GRN DONE.
 * Replaces waiting forever on invoice.posted webhook.
 */

import type { Db } from 'mongodb';
import { resolveSalesApiAccess } from '@/lib/api/integration-links';
import { createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';
import { fetchPostedInvoicesFromSalesVendor } from '@/lib/api/invoice-sync-fetch';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import type { JsonObject } from '@/types/json';

export type GrnInvoiceReconcileResult =
  | { ok: true; noInvoice: string; invoiceId?: string; hutangId?: string; source: 'sales-pull' }
  | { ok: false; reason: string };

export async function reconcileGrnInvoiceFromSales(
  db: Db,
  grn: {
    id?: string;
    tenantId?: string;
    noDO?: string | null;
    vendorTenantId?: string | null;
    noInvoice?: string | null;
  },
): Promise<GrnInvoiceReconcileResult> {
  const noDO = String(grn.noDO || '').trim();
  if (!noDO) return { ok: false, reason: 'no_do' };
  if (grn.noInvoice) {
    return { ok: true, noInvoice: String(grn.noInvoice), source: 'sales-pull' };
  }

  const tid = normalizeTenantId(String(grn.tenantId || 'default'));
  const vendorId = grn.vendorTenantId ? String(grn.vendorTenantId) : undefined;
  const access = await resolveSalesApiAccess(db, tid, vendorId);
  if (!access?.salesApiKey) {
    return { ok: false, reason: 'not_paired' };
  }

  const fetched = await fetchPostedInvoicesFromSalesVendor(
    access.salesAppUrl,
    access.salesApiKey,
    tid,
    vendorId,
    { noDO, db },
  );

  if (fetched.lastError && !fetched.invoices.length) {
    return { ok: false, reason: fetched.lastError };
  }

  const match = fetched.invoices.find((row) => {
    const payload = (row.payload || row) as JsonObject;
    return String(payload.noDO || row.noDO || '').trim() === noDO;
  });
  if (!match) {
    return { ok: false, reason: 'invoice_not_on_sales_yet' };
  }

  const payload = (match.payload || match) as JsonObject;
  const vendorTenantId = match.vendorTenantId || vendorId || null;
  const result = await createHutangFromVendorInvoice(
    db,
    tid,
    payload,
    vendorTenantId ? String(vendorTenantId) : null,
    { createdVia: 'invoice-posted-webhook' },
  );

  if ('error' in result && result.error) {
    return { ok: false, reason: String(result.error) };
  }

  const noInvoice = String(payload.noInvoice || result.noHutang || '');
  if (!noInvoice) {
    return { ok: false, reason: 'no_invoice_after_hutang' };
  }

  return {
    ok: true,
    noInvoice,
    invoiceId: payload.invoiceId ? String(payload.invoiceId) : undefined,
    hutangId: result.hutangId ? String(result.hutangId) : undefined,
    source: 'sales-pull',
  };
}
