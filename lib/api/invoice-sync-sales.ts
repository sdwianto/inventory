// Tarik invoice posted dari sales.app (fallback jika webhook terlewat).

import type { Db } from 'mongodb';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';
import { reconcileVendorHutangFromPostedGrns } from '@/lib/api/hutang-reconcile';
import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import type { JsonObject } from '@/types/json';

interface SyncErrorRow {
  noInvoice?: unknown;
  error: string;
}

export async function syncPostedInvoicesFromSales(
  db: Db,
  customerTenantId: string | null | undefined,
  { reconcileSales = false } = {},
) {
  const tid = normalizeTenantId(customerTenantId || 'default');
  const config = await getIntegrationConfig(db, tid);
  if (!config.salesApiKey) {
    return { error: 'Belum terhubung ke sales.app — jalankan pairing dari menu Integrasi' };
  }

  const headers = { 'X-Api-Key': config.salesApiKey };
  let res: Response;
  try {
    res = await fetch(
      `${config.salesAppUrl}/api/integrations/customer-invoices?customerTenantId=${encodeURIComponent(tid)}`,
      { headers, signal: AbortSignal.timeout(30000) },
    );
  } catch (e) {
    const err = e as { cause?: { code?: string }; code?: string; message?: string };
    const code = err?.cause?.code || err?.code;
    if (code === 'ECONNREFUSED') {
      return { error: `Sales.app tidak dapat dihubungi di ${config.salesAppUrl}` };
    }
    return { error: err.message || 'Gagal menghubungi sales.app' };
  }

  let data: JsonObject;
  try {
    data = await res.json() as JsonObject;
  } catch {
    if (res.status === 404) {
      return {
        error: 'Endpoint customer-invoices belum tersedia di sales.app — gunakan webhook invoice.posted',
        skipped: true,
      };
    }
    return { error: `Sales.app merespons HTTP ${res.status} tanpa JSON valid` };
  }

  if (!res.ok) {
    if (res.status === 404) {
      return {
        error: 'Endpoint customer-invoices belum tersedia di sales.app',
        skipped: true,
      };
    }
    return { error: String(data.error || `Sales.app ${res.status}`) };
  }

  const results = { created: 0, existing: 0, refreshed: 0, errors: [] as SyncErrorRow[] };
  const invoices = Array.isArray(data.invoices) ? data.invoices as JsonObject[] : [];
  for (const row of invoices) {
    try {
      const payload = (row.payload || row) as JsonObject;
      const vendorTenantId = row.vendorTenantId || config.vendorTenantId;
      const before = payload.invoiceId
        ? await db.collection('hutang').findOne({
          vendorInvoiceId: payload.invoiceId,
          ...tenantIdMatchFilter(tid),
        })
        : null;
      const result = await createHutangFromVendorInvoice(
        db,
        tid,
        payload,
        vendorTenantId ? String(vendorTenantId) : null,
      );
      if ('error' in result && result.error) {
        results.errors.push({ noInvoice: payload.noInvoice, error: String(result.error) });
      } else if (result.action === 'refreshed') {
        results.refreshed += 1;
      } else if (result.action === 'created') {
        results.created += 1;
      } else if (result.action === 'exists' || before) {
        results.existing += 1;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const payload = (row.payload || row) as JsonObject;
      results.errors.push({ noInvoice: payload?.noInvoice, error: msg });
    }
  }

  const salesDoSet = new Set<string>(
    invoices
      .map((row) => String((row.payload as JsonObject | undefined)?.noDO || row.noDO || ''))
      .filter(Boolean),
  );

  return {
    ...results,
    total: invoices.length,
    customerTenantId: tid,
    salesDoSet: [...salesDoSet],
    reconcile: reconcileSales
      ? await reconcileVendorHutangFromPostedGrns(db, tid, { callSales: true, salesDoSet })
      : await reconcileVendorHutangFromPostedGrns(db, tid, { callSales: false, salesDoSet }),
    hint: invoices.length === 0
      ? 'Tidak ada invoice POSTED untuk customerTenantId ini — pastikan webhook invoice.posted aktif atau gunakan Sync dengan replaySales'
      : undefined,
  };
}
