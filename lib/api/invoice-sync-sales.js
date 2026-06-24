// Tarik invoice posted dari sales.app (fallback jika webhook terlewat).

import { getIntegrationConfig } from '@/lib/api/integration-config';
import { createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';
import { reconcileVendorHutangFromPostedGrns } from '@/lib/api/hutang-reconcile';
import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';

export async function syncPostedInvoicesFromSales(db, customerTenantId) {
  const tid = normalizeTenantId(customerTenantId || 'default');
  const config = await getIntegrationConfig(db, tid);
  if (!config.salesApiKey) {
    return { error: 'Belum terhubung ke sales.app — jalankan pairing dari menu Integrasi' };
  }

  const headers = { 'X-Api-Key': config.salesApiKey };
  let res;
  try {
    res = await fetch(
      `${config.salesAppUrl}/api/integrations/customer-invoices?customerTenantId=${encodeURIComponent(tid)}`,
      { headers, signal: AbortSignal.timeout(30000) },
    );
  } catch (e) {
    const code = e?.cause?.code || e?.code;
    if (code === 'ECONNREFUSED') {
      return { error: `Sales.app tidak dapat dihubungi di ${config.salesAppUrl}` };
    }
    return { error: e.message || 'Gagal menghubungi sales.app' };
  }

  let data;
  try {
    data = await res.json();
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
    return { error: data.error || `Sales.app ${res.status}` };
  }

  const results = { created: 0, existing: 0, refreshed: 0, errors: [] };
  for (const row of data.invoices || []) {
    try {
      const payload = row.payload || row;
      const vendorTenantId = row.vendorTenantId || config.vendorTenantId;
      const before = payload.invoiceId
        ? await db.collection('hutang').findOne({
          vendorInvoiceId: payload.invoiceId,
          ...tenantIdMatchFilter(tid),
        })
        : null;
      const result = await createHutangFromVendorInvoice(db, tid, payload, vendorTenantId);
      if (result.error) {
        results.errors.push({ noInvoice: payload.noInvoice, error: result.error });
      } else if (result.action === 'refreshed') {
        results.refreshed += 1;
      } else if (result.action === 'created') {
        results.created += 1;
      } else if (result.action === 'exists' || before) {
        results.existing += 1;
      }
    } catch (e) {
      results.errors.push({ noInvoice: row.payload?.noInvoice, error: e.message });
    }
  }

  const salesDoSet = new Set(
    (data.invoices || [])
      .map((row) => row.payload?.noDO || row.noDO)
      .filter(Boolean),
  );

  return {
    ...results,
    total: (data.invoices || []).length,
    customerTenantId: tid,
    salesDoSet: [...salesDoSet],
    reconcile: await reconcileVendorHutangFromPostedGrns(db, tid, {
      callSales: true,
      salesDoSet,
    }),
    hint: (data.invoices || []).length === 0
      ? 'Tidak ada invoice POSTED untuk customerTenantId ini — pastikan pelanggan B2B di sales.app punya customerTenantId yang sama dengan tenant inventory'
      : undefined,
  };
}
