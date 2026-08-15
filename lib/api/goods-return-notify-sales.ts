/** Category A: notify Sales that RTV is POSTED → CreateCreditNote. */

import type { Db } from 'mongodb';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { resolveEffectiveSalesAppUrl } from '@/lib/api/sales-app-url';
import { createIntegrationClient } from '@/lib/integration/client';
import { IntegrationError } from '@/lib/integration/errors';
import { integrationCorrelationId } from '@/lib/api/integration-common';
import { applyCreditNoteFromVendor } from '@/lib/api/hutang-from-vendor';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import type { VendorReturnDoc } from '@/types/vendor-return';

export async function notifySalesGoodsReturnPosted(
  db: Db,
  tenantId: string,
  doc: VendorReturnDoc,
): Promise<{
  ok: boolean;
  skipped?: boolean;
  creditNoteId?: string;
  noCN?: string;
  amount?: number;
  error?: string;
}> {
  const tid = normalizeTenantId(tenantId);
  const vendorTenantId = String(doc.vendorTenantId || '').trim();
  const apiKey = await getSalesApiKeyForVendor(db, tid, vendorTenantId || undefined);
  const salesAppUrl = resolveEffectiveSalesAppUrl();
  if (!apiKey || !salesAppUrl) {
    return { ok: true, skipped: true };
  }

  const client = createIntegrationClient(db);
  try {
    const result = await client.postGoodsReturnPosted({
      salesAppUrl,
      apiKey,
      idempotencyKey: doc.id,
      correlationId: integrationCorrelationId(`rtv:${doc.id}`),
      returnId: doc.id,
      body: {
        customerTenantId: tid,
        vendorTenantId,
        returnId: doc.id,
        noReturn: doc.noReturn,
        invoiceId: doc.vendorInvoiceId || '',
        noInvoice: doc.noInvoice,
        noDO: doc.noDO || '',
        noGRN: doc.noGRN || '',
        grnId: doc.grnId || '',
        noPO: doc.noPO || '',
        noSO: doc.noSO || '',
        postedAt: doc.postedAt ? new Date(doc.postedAt).toISOString() : new Date().toISOString(),
        reason: doc.reason,
        items: (doc.items || []).map((it) => ({
          lineId: it.invoiceLineId || it.lineId,
          kode: it.vendorKode || it.localKode,
          nama: it.localNama,
          satuan: it.satuan,
          uomId: it.vendorUomId || it.uomId,
          qty: it.qty,
          harga: it.harga,
          stokId: undefined,
        })),
      },
    });

    const applied = await applyCreditNoteFromVendor(
      db,
      tid,
      {
        invoiceId: result.invoiceId || doc.vendorInvoiceId || '',
        noInvoice: result.noInvoice || doc.noInvoice,
        total: result.amount,
        creditNoteId: result.creditNoteId,
        noCN: result.noCN,
        postedAt: new Date(),
        items: (doc.items || []).map((it) => ({
          lineId: it.invoiceLineId || it.lineId,
          stokId: it.localStokId,
          uomId: it.vendorUomId || it.uomId,
          satuan: it.satuan,
          qty: it.qty,
          qtyBase: it.qtyBase,
        })),
        source: 'inventory_return',
        noReturn: doc.noReturn,
      },
      vendorTenantId,
      { appliedVia: 'credit-note-posted-push', correlationId: `rtv:${doc.id}` },
    );
    if (applied && 'error' in applied && applied.error) {
      return {
        ok: false,
        error: String(applied.error),
        creditNoteId: result.creditNoteId,
        noCN: result.noCN,
        amount: result.amount,
      };
    }

    return {
      ok: true,
      creditNoteId: result.creditNoteId,
      noCN: result.noCN,
      amount: result.amount,
    };
  } catch (e) {
    const msg = e instanceof IntegrationError ? e.message : (e instanceof Error ? e.message : String(e));
    return { ok: false, error: msg };
  }
}
