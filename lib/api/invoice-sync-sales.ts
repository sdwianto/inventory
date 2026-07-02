// Tarik invoice posted dari sales.app (fallback jika webhook terlewat).

import type { Db } from 'mongodb';
import { listActiveLinksForCustomer, resolveSalesApiAccess } from '@/lib/api/integration-links';
import { createHutangFromVendorInvoice } from '@/lib/api/hutang-from-vendor';
import { reconcileVendorHutangFromPostedGrns } from '@/lib/api/hutang-reconcile';
import { fetchPostedInvoicesFromSalesVendor } from '@/lib/api/invoice-sync-fetch';
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
  const links = await listActiveLinksForCustomer(db, tid);

  const vendorsToSync: { vendorTenantId: string; salesAppUrl: string; salesApiKey: string }[] = [];
  if (links.length) {
    for (const link of links) {
      const access = await resolveSalesApiAccess(db, tid, link.vendorTenantId);
      if (access?.salesApiKey) {
        vendorsToSync.push({
          vendorTenantId: link.vendorTenantId,
          salesAppUrl: access.salesAppUrl,
          salesApiKey: access.salesApiKey,
        });
      }
    }
  } else {
    const access = await resolveSalesApiAccess(db, tid);
    if (access?.salesApiKey) {
      vendorsToSync.push({
        vendorTenantId: '',
        salesAppUrl: access.salesAppUrl,
        salesApiKey: access.salesApiKey,
      });
    }
  }

  if (!vendorsToSync.length) {
    return { error: 'Belum terhubung ke sales.app — jalankan pairing dari menu Integrasi' };
  }

  const invoices: JsonObject[] = [];
  const fetchWarnings: string[] = [];
  let fetchIncomplete = false;

  for (const vendor of vendorsToSync) {
    const fetched = await fetchPostedInvoicesFromSalesVendor(
      vendor.salesAppUrl,
      vendor.salesApiKey,
      tid,
      vendor.vendorTenantId || undefined,
    );
    if (fetched.lastError && !fetched.invoices.length && !invoices.length && vendorsToSync.length === 1) {
      if (fetched.lastError.includes('belum tersedia')) {
        return { error: fetched.lastError, skipped: true };
      }
      return { error: fetched.lastError };
    }
    if (fetched.fetchIncomplete) {
      fetchIncomplete = true;
      if (fetched.lastError) fetchWarnings.push(fetched.lastError);
    }
    invoices.push(...fetched.invoices);
  }

  const results = { created: 0, existing: 0, refreshed: 0, errors: [] as SyncErrorRow[] };

  const invoiceIds = invoices
    .map((row) => {
      const payload = (row.payload || row) as JsonObject;
      return payload.invoiceId ? String(payload.invoiceId) : null;
    })
    .filter(Boolean) as string[];

  const existingHutang = invoiceIds.length
    ? await db.collection('hutang').find({
      vendorInvoiceId: { $in: invoiceIds },
      ...tenantIdMatchFilter(tid),
    }).project({ vendorInvoiceId: 1 }).toArray()
    : [];
  const existingSet = new Set(existingHutang.map((h) => String(h.vendorInvoiceId)));

  for (const row of invoices) {
    try {
      const payload = (row.payload || row) as JsonObject;
      const vendorTenantId = row.vendorTenantId || null;
      const hadBefore = payload.invoiceId ? existingSet.has(String(payload.invoiceId)) : false;
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
      } else if (result.action === 'exists' || hadBefore) {
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
    vendorsSynced: vendorsToSync.length,
    salesDoSet: [...salesDoSet],
    fetchIncomplete,
    fetchWarnings: fetchWarnings.length ? fetchWarnings : undefined,
    warning: fetchIncomplete
      ? 'Sync invoice tidak lengkap — sebagian halaman gagal diambil dari sales.app'
      : undefined,
    reconcile: reconcileSales
      ? await reconcileVendorHutangFromPostedGrns(db, tid, { queueSalesReplays: true, salesDoSet })
      : await reconcileVendorHutangFromPostedGrns(db, tid, { salesDoSet }),
    hint: invoices.length === 0
      ? 'Tidak ada invoice POSTED untuk customerTenantId ini — pastikan webhook invoice.posted aktif atau gunakan Sync dengan replaySales'
      : undefined,
  };
}
