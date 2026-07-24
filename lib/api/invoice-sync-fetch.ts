/** Fetch invoice posted dari sales.app — satu vendor, dengan deteksi partial fetch. H2: SDK. */

import type { Db } from 'mongodb';
import type { JsonObject } from '@/types/json';
import { createIntegrationClient } from '@/lib/integration/client';
import { IntegrationError } from '@/lib/integration/errors';
import { randomUUID } from 'node:crypto';

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
  opts: { noDO?: string; db?: Db } = {},
): Promise<InvoiceSyncFetchResult> {
  const invoices: JsonObject[] = [];
  let cursor: string | null = null;
  let hasMore = true;
  let pagesFetched = 0;
  let fetchIncomplete = false;
  let lastError: string | undefined;
  const noDO = String(opts.noDO || '').trim();
  const db = opts.db;
  if (!db) {
    // Backward-compatible: callers must pass db for SDK; keep soft error if missing.
    return {
      invoices: [],
      fetchIncomplete: false,
      lastError: 'db required for IntegrationClient pullPostedInvoices',
      pagesFetched: 0,
    };
  }
  const client = createIntegrationClient(db);
  const correlationId = randomUUID();

  while (hasMore) {
    let data: Record<string, unknown>;
    try {
      data = await client.pullPostedInvoicesPage({
        salesAppUrl,
        apiKey: salesApiKey,
        correlationId,
        query: {
          customerTenantId,
          vendorTenantId,
          noDO: noDO || undefined,
          cursor,
          limit: 100,
        },
        timeoutMs: 60_000,
      });
    } catch (e) {
      if (e instanceof IntegrationError) {
        lastError = e.message;
        if (e.httpStatus === 404) {
          return {
            invoices: [],
            fetchIncomplete: false,
            lastError: 'Endpoint customer-invoices belum tersedia di sales.app',
            pagesFetched,
          };
        }
      } else {
        const err = e as { cause?: { code?: string }; code?: string; message?: string };
        const code = err?.cause?.code || err?.code;
        lastError = code === 'ECONNREFUSED'
          ? `Sales.app tidak dapat dihubungi di ${salesAppUrl}`
          : (err.message || 'Gagal menghubungi sales.app');
      }
      if (invoices.length > 0) {
        fetchIncomplete = true;
        break;
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
