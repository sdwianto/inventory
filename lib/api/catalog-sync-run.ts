/** Sinkron katalog sales.app → produk inventory (paginated + batch upsert). */

import type { Db } from 'mongodb';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { bulkUpsertProductsFromVendor } from '@/lib/api/product-sync-batch';
import {
  upsertVendorTenant,
  upsertVendorTenantsFromCatalog,
  backfillProductVendorNames,
} from '@/lib/api/vendor-tenants';
import { syncVendorTiersFromSales } from '@/lib/api/vendor-tier-sync';
import { refreshUnresolvedGrnsForTenant } from '@/lib/api/grn-resolve-products';
import type { JsonObject } from '@/types/json';

const CATALOG_PAGE_SIZE = 500;
const CATALOG_FETCH_TIMEOUT_MS = 60_000;

function salesFetchErrorMessage(err: unknown, salesUrl: string) {
  const e = err as { cause?: { code?: string; message?: string }; code?: string; message?: string; name?: string };
  const cause = e?.cause;
  const code = cause?.code || e?.code;
  if (code === 'ECONNREFUSED') {
    return `Sales.app tidak dapat dihubungi di ${salesUrl}. Pastikan sales.app sudah berjalan (port 3000).`;
  }
  if (code === 'ENOTFOUND') {
    return `Alamat sales.app tidak ditemukan: ${salesUrl}`;
  }
  if (e?.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return `Sales.app tidak merespons (timeout) — cek ${salesUrl}`;
  }
  return `Gagal menghubungi sales.app: ${cause?.message || e?.message || 'koneksi gagal'}`;
}

function buildCatalogUrl(
  baseUrl: string,
  { cursor, updatedSince }: { cursor?: string; updatedSince?: Date | null },
): string {
  const u = new URL(`${baseUrl.replace(/\/$/, '')}/api/integrations/catalog`);
  u.searchParams.set('allTenants', 'true');
  u.searchParams.set('limit', String(CATALOG_PAGE_SIZE));
  if (cursor) u.searchParams.set('cursor', cursor);
  if (updatedSince) u.searchParams.set('updatedSince', updatedSince.toISOString());
  return u.toString();
}

async function fetchCatalogPage(
  salesAppUrl: string,
  headers: Record<string, string>,
  opts: { cursor?: string; updatedSince?: Date | null },
): Promise<{ ok: true; data: JsonObject } | { ok: false; error: string; offline?: boolean }> {
  let res: Response;
  try {
    res = await fetch(buildCatalogUrl(salesAppUrl, opts), {
      headers,
      signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: salesFetchErrorMessage(e, salesAppUrl), offline: true };
  }

  let data: JsonObject;
  try {
    data = await res.json() as JsonObject;
  } catch {
    return { ok: false, error: `Sales.app merespons HTTP ${res.status} tanpa data JSON valid` };
  }
  if (!res.ok) return { ok: false, error: String(data.error || `Sales.app ${res.status}`) };
  return { ok: true, data };
}

/** Legacy monolithic response (sales lama tanpa pagination). */
function isLegacyCatalogPayload(data: JsonObject): boolean {
  return data.hasMore === undefined && data.nextCursor === undefined && Array.isArray(data.products);
}

export async function runCatalogSync(db: Db, tenantId: string, config: { salesAppUrl?: string }) {
  const salesAppUrl = config.salesAppUrl || '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = await getSalesApiKeyForVendor(db, tenantId);
  if (apiKey) headers['X-Api-Key'] = apiKey;

  const settingsRow = await db.collection('integration_settings').findOne({ tenantId });
  const lastSync = settingsRow?.lastCatalogSyncAt ? new Date(settingsRow.lastCatalogSyncAt) : null;

  const results: {
    created: number;
    updated: number;
    errors: JsonObject[];
    byVendor: Record<string, number>;
  } = { created: 0, updated: 0, errors: [], byVendor: {} };

  let cursor: string | undefined;
  let page = 0;
  let totalFetched = 0;
  let availableTenants: unknown = null;
  let usedPagination = false;

  for (;;) {
    page += 1;
    const pageRes = await fetchCatalogPage(salesAppUrl, headers, {
      cursor,
      updatedSince: page === 1 ? lastSync : null,
    });
    if (!pageRes.ok) {
      if (totalFetched > 0) break;
      return { error: pageRes.error, offline: pageRes.offline };
    }

    const data = pageRes.data;
    if (page === 1 && data.availableTenants) {
      availableTenants = data.availableTenants;
      const tenants = Array.isArray(data.availableTenants) ? data.availableTenants : [];
      await upsertVendorTenantsFromCatalog(
        db,
        tenantId,
        tenants as Array<{ tenantId: string; tenantName?: string; companyName?: string }>,
      );
    }

    const products = Array.isArray(data.products) ? data.products as JsonObject[] : [];
    if (!products.length && page === 1 && !isLegacyCatalogPayload(data)) {
      const now = new Date();
      await db.collection('integration_settings').updateOne(
        { tenantId },
        { $set: { lastCatalogSyncAt: now, updatedAt: now } },
      );
      return {
        ...results,
        total: 0,
        pages: 0,
        allTenants: true,
        incremental: !!lastSync,
        message: 'Katalog sudah up-to-date',
      };
    }

    if (products.length) {
      const vendorNamesDone = new Set<string>();
      for (const p of products) {
        const vTenant = String(p.vendorTenantId || p.tenantId || '').trim();
        if (vTenant && p.vendorTenantName && !vendorNamesDone.has(vTenant)) {
          await upsertVendorTenant(db, tenantId, vTenant, String(p.vendorTenantName));
          vendorNamesDone.add(vTenant);
        }
      }
      const batch = await bulkUpsertProductsFromVendor(db, tenantId, products);
      results.created += batch.created;
      results.updated += batch.updated;
      results.errors.push(...batch.errors);
      for (const [v, n] of Object.entries(batch.byVendor)) {
        results.byVendor[v] = (results.byVendor[v] || 0) + n;
      }
      totalFetched += products.length;
    }

    const hasMore = data.hasMore === true;
    const nextCursor = data.nextCursor != null ? String(data.nextCursor) : '';
    if (hasMore && nextCursor) {
      usedPagination = true;
      cursor = nextCursor;
      continue;
    }

    if (isLegacyCatalogPayload(data) || !hasMore) break;
    break;
  }

  if (totalFetched === 0 && results.errors.length === 0) {
    return { error: 'Katalog kosong di sales.app — pastikan ada produk aktif' };
  }

  const namesBackfilled = await backfillProductVendorNames(db, tenantId);
  const tierSync = await syncVendorTiersFromSales(db, tenantId, config);
  const grnRefreshed = await refreshUnresolvedGrnsForTenant(db, tenantId);
  const vendorTenants = Object.keys(results.byVendor);
  const now = new Date();
  await db.collection('integration_settings').updateOne(
    { tenantId },
    { $set: { lastCatalogSyncAt: now, updatedAt: now } },
  );

  return {
    ...results,
    total: totalFetched,
    pages: page,
    paginated: usedPagination,
    allTenants: true,
    incremental: !!lastSync,
    vendorTenants,
    vendorTenantCount: vendorTenants.length,
    vendorNamesBackfilled: namesBackfilled,
    tierSync: tierSync?.error ? { error: tierSync.error } : tierSync,
    grnRefreshed,
    availableTenants,
  };
}
