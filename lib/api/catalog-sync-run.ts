/** Sinkron katalog sales.app → produk inventory (paginated + batch upsert). H2: SDK. */

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
import { createIntegrationClient } from '@/lib/integration/client';
import { IntegrationError } from '@/lib/integration/errors';
import type { JsonObject } from '@/types/json';
import { randomUUID } from 'node:crypto';

const CATALOG_PAGE_SIZE = 500;
const CATALOG_FETCH_TIMEOUT_MS = 60_000;

async function fetchCatalogPage(
  db: Db,
  salesAppUrl: string,
  apiKey: string,
  opts: { cursor?: string; updatedSince?: Date | null; correlationId?: string },
): Promise<{ ok: true; data: JsonObject } | { ok: false; error: string; offline?: boolean }> {
  try {
    const client = createIntegrationClient(db);
    const data = await client.pullCatalogPage({
      salesAppUrl,
      apiKey,
      correlationId: opts.correlationId || randomUUID(),
      query: {
        cursor: opts.cursor,
        updatedSince: opts.updatedSince ? opts.updatedSince.toISOString() : null,
        limit: CATALOG_PAGE_SIZE,
      },
      timeoutMs: CATALOG_FETCH_TIMEOUT_MS,
    });
    return { ok: true, data: data as JsonObject };
  } catch (e) {
    if (e instanceof IntegrationError) {
      if (e.errorClass === 'bulkhead') {
        return { ok: false, error: 'Bulkhead catalog saturated — coba lagi nanti' };
      }
      const offline = e.errorClass === 'network' || e.errorClass === 'timeout' || e.errorClass === 'circuit_open';
      return { ok: false, error: e.message, offline };
    }
    return { ok: false, error: salesFetchErrorMessage(e, salesAppUrl), offline: true };
  }
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
  db: Db,
  salesAppUrl: string,
  apiKey: string,
  onProgress?: (page: number, keyCount: number) => Promise<void>,
): Promise<{ keys: Set<string>; ok: boolean }> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  let page = 0;
  const correlationId = randomUUID();

  for (;;) {
    page += 1;
    const pageRes = await fetchCatalogPage(db, salesAppUrl, apiKey, {
      cursor,
      updatedSince: null,
      correlationId,
    });
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
  apiKey: string,
  jobId?: string,
) {
  await updateJobProgress(db, jobId, {
    phase: 'reconcile',
    message: 'Rekonsiliasi produk yang tidak ada di sales…',
  });
  const scan = await fetchAllCatalogVendorKeys(db, salesAppUrl, apiKey, async (page, keyCount) => {
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
  const apiKey = await getSalesApiKeyForVendor(db, tenantId);
  if (!apiKey) {
    return { error: 'Belum di-pair dengan sales.app' };
  }
  if (!salesAppUrl) {
    return { error: 'salesAppUrl belum di-set' };
  }

  const settingsRow = await db.collection('integration_settings').findOne({ tenantId });
  const lastSync = settingsRow?.lastCatalogSyncAt ? new Date(settingsRow.lastCatalogSyncAt) : null;
  const correlationId = randomUUID();

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

    const pageRes = await fetchCatalogPage(db, salesAppUrl, apiKey, {
      cursor,
      updatedSince: lastSync,
      correlationId,
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
        const reconcile = await runCatalogReconcile(db, tenantId, salesAppUrl, apiKey, opts.jobId);
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
    const reconcile = await runCatalogReconcile(db, tenantId, salesAppUrl, apiKey, opts.jobId);
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
