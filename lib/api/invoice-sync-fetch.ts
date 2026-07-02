/** Fetch invoice posted dari sales.app — satu vendor, dengan deteksi partial fetch. */

import type { JsonObject } from '@/types/json';

export interface InvoiceSyncFetchResult {
  invoices: JsonObject[];
  fetchIncomplete: boolean;
  lastError?: string;
  pagesFetched: number;
}

export async function fetchPostedInvoicesFromSalesVendor(
  salesAppUrl: string,
  salesApiKey: string,
  customerTenantId: string,
  vendorTenantId?: string,
): Promise<InvoiceSyncFetchResult> {
  const headers = { 'X-Api-Key': salesApiKey };
  const invoices: JsonObject[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  let pagesFetched = 0;
  let fetchIncomplete = false;
  let lastError: string | undefined;

  while (hasMore) {
    let fetchUrl = `${salesAppUrl}/api/integrations/customer-invoices?customerTenantId=${encodeURIComponent(customerTenantId)}&pageMode=cursor&limit=100`;
    if (vendorTenantId) {
      fetchUrl += `&vendorTenantId=${encodeURIComponent(vendorTenantId)}`;
    }
    if (cursor) fetchUrl += `&cursor=${encodeURIComponent(cursor)}`;

    let res: Response;
    try {
      res = await fetch(fetchUrl, { headers, signal: AbortSignal.timeout(60000) });
    } catch (e) {
      const err = e as { cause?: { code?: string }; code?: string; message?: string };
      const code = err?.cause?.code || err?.code;
      lastError = code === 'ECONNREFUSED'
        ? `Sales.app tidak dapat dihubungi di ${salesAppUrl}`
        : (err.message || 'Gagal menghubungi sales.app');
      if (invoices.length > 0) {
        fetchIncomplete = true;
        break;
      }
      return { invoices: [], fetchIncomplete: false, lastError, pagesFetched };
    }

    let data: JsonObject;
    try {
      data = await res.json() as JsonObject;
    } catch {
      lastError = `Sales.app merespons HTTP ${res.status} tanpa JSON valid`;
      if (invoices.length > 0) {
        fetchIncomplete = true;
        break;
      }
      if (res.status === 404) {
        return {
          invoices: [],
          fetchIncomplete: false,
          lastError: 'Endpoint customer-invoices belum tersedia di sales.app',
          pagesFetched,
        };
      }
      return { invoices: [], fetchIncomplete: false, lastError, pagesFetched };
    }

    if (!res.ok) {
      lastError = String(data.error || `Sales.app ${res.status}`);
      if (invoices.length > 0) {
        fetchIncomplete = true;
        break;
      }
      if (res.status === 404) {
        return {
          invoices: [],
          fetchIncomplete: false,
          lastError: 'Endpoint customer-invoices belum tersedia di sales.app',
          pagesFetched,
        };
      }
      return { invoices: [], fetchIncomplete: false, lastError, pagesFetched };
    }

    const pageRows = Array.isArray(data.invoices) ? data.invoices as JsonObject[] : [];
    invoices.push(...pageRows);
    pagesFetched += 1;
    hasMore = Boolean(data.hasMore && data.nextCursor);
    cursor = data.nextCursor ? String(data.nextCursor) : null;
    if (!hasMore || !cursor) break;
  }

  return { invoices, fetchIncomplete, lastError, pagesFetched };
}
