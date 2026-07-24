/** Sinkron katalog sales.app → produk inventory (paginated + batch upsert). */

import type { Db } from 'mongodb';
import { getSalesApiKeyForVendor } from '@/lib/api/integration-links';
import { bulkUpsertProductsFromVendor } from '@/lib/api/product-sync-batch';
import {
  backfillVendorUomLinks,
  reconcileOrphanVendorProducts,
  vendorCatalogKeyFromProduct,
} from '@/lib/api/product-sync';
import {
  upsertVendorTenantsFromCatalog,
  bulkUpsertVendorTenantNames,
  backfillProductVendorNames,
} from '@/lib/api/vendor-tenants';
import { syncVendorTiersFromSales } from '@/lib/api/vendor-tier-sync';
import { refreshUnresolvedGrnsForTenant } from '@/lib/api/grn-resolve-products';
import { updateJobProgress } from '@/lib/api/bg-jobs';
import { salesFetchErrorMessage } from '@/lib/api/integration-common';
import { buildTraceHttpHeaders } from '@/lib/execution/tracing/trace-context';
import type { JsonObject } from '@/types/json';

const CATALOG_PAGE_SIZE = 500;
const CATALOG_FETCH_TIMEOUT_MS = 60_000;

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
    const { withBulkhead } = await import('@/lib/integration/bulkhead');
    res = await withBulkhead('catalog', () => fetch(buildCatalogUrl(salesAppUrl, opts), {
      headers,
      signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
    }));
  } catch (e) {
    const code = e && typeof e === 'object' ? String((e as { code?: string }).code || '') : '';
    if (code === 'BULKHEAD_SATURATED') {
      return { ok: false, error: 'Bulkhead catalog saturated — coba lagi nanti' };
    }
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

/** Ambil semua kunci produk aktif dari katalog sales (tanpa updatedSince) untuk rekonsiliasi. */
const CATALOG_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function shouldRunFullCatalogReconcile(
  settingsRow: unknown,
  lastSync: Date | null,
  force?: boolean,
): boolean {
  if (force) return true;
  // Full sync (belum pernah watermark) — wajib reconcile.
  if (!lastSync) return true;
  const row = settingsRow as { lastCatalogReconcileAt?: unknown } | null | undefined;
  const lastRec = row?.lastCatalogReconcileAt
    ? new Date(String(row.lastCatalogReconcileAt))
    : null;
  if (!lastRec || Number.isNaN(lastRec.getTime())) return true;
  return Date.now() - lastRec.getTime() >= CATALOG_RECONCILE_INTERVAL_MS;
}

async function fetchAllCatalogVendorKeys(
  salesAppUrl: string,
  headers: Record<string, string>,
  onProgress?: (page: number, keyCount: number) => Promise<void>,
): Promise<{ keys: Set<string>; ok: boolean }> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  let page = 0;

  for (;;) {
    page += 1;
    const pageRes = await fetchCatalogPage(salesAppUrl, headers, { cursor, updatedSince: null });
    if (!pageRes.ok) {
      return { keys, ok: keys.size > 0 };
    }

    const data = pageRes.data;
    const products = Array.isArray(data.products) ? data.products as JsonObject[] : [];
    for (const p of products) {
      const key = vendorCatalogKeyFromProduct(p);
      if (key) keys.add(key);
    }
    if (onProgress) await onProgress(page, keys.size);

    const hasMore = data.hasMore === true;
    const nextCursor = data.nextCursor != null ? String(data.nextCursor) : '';
    if (hasMore && nextCursor) {
      cursor = nextCursor;
      continue;
    }
    if (isLegacyCatalogPayload(data) || !hasMore) break;
    break;
  }

  return { keys, ok: true };
}

async function runCatalogReconcile(
  db: Db,
  tenantId: string,
  salesAppUrl: string,
  headers: Record<string, string>,
  jobId?: string,
) {
  await updateJobProgress(db, jobId, {
    phase: 'reconcile',
    message: 'Rekonsiliasi produk yang tidak ada di sales…',
  });
  const scan = await fetchAllCatalogVendorKeys(salesAppUrl, headers, async (page, keyCount) => {
    await updateJobProgress(db, jobId, {
      phase: 'reconcile',
      page,
      totalFetched: keyCount,
      message: `Memindai katalog sales (halaman ${page})…`,
    });
  });
  if (!scan.ok) {
    return { deactivated: 0, sample: [] as string[], skipped: true };
  }
  const result = await reconcileOrphanVendorProducts(db, tenantId, scan.keys);
  return { ...result, skipped: false };
}

export async function runCatalogSync(
  db: Db,
  tenantId: string,
  config: { salesAppUrl?: string },
  opts: { jobId?: string; forceReconcile?: boolean } = {},
) {
  const salesAppUrl = config.salesAppUrl || '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildTraceHttpHeaders(),
  };
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
    await updateJobProgress(db, opts.jobId, {
      phase: 'catalog',
      page,
      totalFetched,
      message: page === 1 ? 'Mengambil katalog dari sales.app…' : `Sync halaman ${page}…`,
    });

    const pageRes = await fetchCatalogPage(salesAppUrl, headers, {
      cursor,
      updatedSince: lastSync,
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
      let deactivated = 0;
      let sample: unknown[] = [];
      const now = new Date();
      if (shouldRunFullCatalogReconcile(settingsRow, lastSync, opts.forceReconcile)) {
        const reconcile = await runCatalogReconcile(db, tenantId, salesAppUrl, headers, opts.jobId);
        deactivated = reconcile.deactivated;
        sample = reconcile.sample;
        await db.collection('integration_settings').updateOne(
          { tenantId },
          { $set: { lastCatalogSyncAt: now, lastCatalogReconcileAt: now, updatedAt: now } },
        );
      } else {
        await db.collection('integration_settings').updateOne(
          { tenantId },
          { $set: { lastCatalogSyncAt: now, updatedAt: now } },
        );
      }
      return {
        ...results,
        total: 0,
        pages: 0,
        allTenants: true,
        incremental: !!lastSync,
        reconciled: deactivated,
        reconciledSample: sample,
        message: deactivated
          ? `Katalog up-to-date — ${deactivated} produk usang dinonaktifkan`
          : 'Katalog sudah up-to-date',
      };
    }

    if (products.length) {
      const vendorNames = new Map<string, string>();
      for (const p of products) {
        const vTenant = String(p.vendorTenantId || p.tenantId || '').trim();
        if (vTenant && p.vendorTenantName) {
          vendorNames.set(vTenant, String(p.vendorTenantName));
        }
      }
      await bulkUpsertVendorTenantNames(db, tenantId, vendorNames);
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

  let reconciled = 0;
  let reconciledSample: unknown[] = [];
  const doReconcile = shouldRunFullCatalogReconcile(settingsRow, lastSync, opts.forceReconcile);
  if (doReconcile) {
    const reconcile = await runCatalogReconcile(db, tenantId, salesAppUrl, headers, opts.jobId);
    reconciled = reconcile.deactivated;
    reconciledSample = reconcile.sample;
  }
  const namesBackfilled = await backfillProductVendorNames(db, tenantId);
  const uomBackfill = await backfillVendorUomLinks(db, tenantId);
  const tierSync = await syncVendorTiersFromSales(db, tenantId, config);
  const grnRefreshed = await refreshUnresolvedGrnsForTenant(db, tenantId);
  const vendorTenants = Object.keys(results.byVendor);
  const now = new Date();
  await db.collection('integration_settings').updateOne(
    { tenantId },
    {
      $set: {
        lastCatalogSyncAt: now,
        updatedAt: now,
        ...(doReconcile ? { lastCatalogReconcileAt: now } : {}),
      },
    },
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
    uomVendorLinksBackfilled: uomBackfill.fixed,
    tierSync: tierSync?.error ? { error: tierSync.error } : tierSync,
    grnRefreshed,
    reconciled,
    reconciledSample,
    reconcileSkipped: !doReconcile,
    availableTenants,
  };
}
