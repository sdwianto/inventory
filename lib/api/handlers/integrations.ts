import type { HandlerContext } from '@/types/api/handler';
import { parseHandlerBody } from '@/types/api/handler';
import type { Db } from 'mongodb';
// Pairing & status integrasi dengan sales.app (vendor).

import { ok, err, clean } from '@/lib/api/db';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { getIntegrationConfig, getSetupToken } from '@/lib/api/integration-config';
import {
  listActiveLinksForCustomer,
  upsertIntegrationLink,
  getSalesApiKeyForVendor,
} from '@/lib/api/integration-links';
import { upsertProductFromVendor } from '@/lib/api/product-sync';
import {
  upsertVendorTenant,
  upsertVendorTenantsFromCatalog,
  backfillProductVendorNames,
} from '@/lib/api/vendor-tenants';
import { syncVendorTiersFromSales } from '@/lib/api/vendor-tier-sync';
import type { JsonObject } from '@/types/json';
import { getInventoryPairUrl, getInventoryWebhookUrl } from '@/lib/integration-public-url';

const AUTO_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000;

function salesFetchErrorMessage(err, salesUrl) {
  const cause = err?.cause || err;
  const code = cause?.code || err?.code;
  if (code === 'ECONNREFUSED') {
    return `Sales.app tidak dapat dihubungi di ${salesUrl}. Pastikan sales.app sudah berjalan (port 3000).`;
  }
  if (code === 'ENOTFOUND') {
    return `Alamat sales.app tidak ditemukan: ${salesUrl}`;
  }
  if (err?.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return `Sales.app tidak merespons (timeout) — cek ${salesUrl}`;
  }
  return `Gagal menghubungi sales.app: ${cause?.message || err?.message || 'koneksi gagal'}`;
}

async function runCatalogSync(db: Db, tenantId, config) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = await getSalesApiKeyForVendor(db, tenantId);
  if (apiKey) headers['X-Api-Key'] = apiKey;

  let res;
  try {
    // Katalog global — semua produk dari semua tenant vendor sales.app
    res = await fetch(
      `${config.salesAppUrl}/api/integrations/catalog?allTenants=true`,
      { headers, signal: AbortSignal.timeout(60000) },
    );
  } catch (e) {
    return { error: salesFetchErrorMessage(e, config.salesAppUrl), offline: true };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { error: `Sales.app merespons HTTP ${res.status} tanpa data JSON valid` };
  }
  if (!res.ok) return { error: data.error || `Sales.app ${res.status}` };

  const products = data.products || [];
  if (!products.length) {
    return { error: 'Katalog kosong di sales.app — pastikan ada produk aktif' };
  }

  await upsertVendorTenantsFromCatalog(db, tenantId, data.availableTenants || []);

  const results: {
    created: number;
    updated: number;
    errors: JsonObject[];
    byVendor: Record<string, number>;
  } = { created: 0, updated: 0, errors: [], byVendor: {} };
  for (const p of products) {
    const vTenant = p.vendorTenantId || p.tenantId;
    if (!vTenant) {
      results.errors.push({ kode: p.kode, error: 'missing vendorTenantId' });
      continue;
    }
    if (p.vendorTenantName) {
      await upsertVendorTenant(db, tenantId, vTenant, p.vendorTenantName);
    }
    try {
      const r = await upsertProductFromVendor(db, tenantId, vTenant, p);
      if (r.action === 'created') results.created += 1;
      else results.updated += 1;
      results.byVendor[vTenant] = (results.byVendor[vTenant] || 0) + 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.errors.push({ kode: p.kode, vendorTenantId: vTenant, error: msg });
    }
  }

  const namesBackfilled = await backfillProductVendorNames(db, tenantId);
  const tierSync = await syncVendorTiersFromSales(db, tenantId, config);
  const vendorTenants = Object.keys(results.byVendor);
  const now = new Date();
  await db.collection('integration_settings').updateOne(
    { tenantId },
    { $set: { lastCatalogSyncAt: now, updatedAt: now } },
  );
  return {
    ...results,
    total: products.length,
    allTenants: true,
    vendorTenants,
    vendorTenantCount: vendorTenants.length,
    vendorNamesBackfilled: namesBackfilled,
    tierSync: tierSync?.error ? { error: tierSync.error } : tierSync,
  };
}

export async function handleIntegrations({
  db, route, method, body, auth, url, request,
}: HandlerContext) {
  const intBody = parseHandlerBody(body);
  const scopeOpts = { url, body: intBody, request };

  if (route === '/integrations/setup-info' && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
    const proto = request.headers.get('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
    const originFromRequest = host ? `${proto}://${host.split(',')[0].trim()}` : '';
    return ok({
      tenantId: tenantId || '',
      webhookUrl: getInventoryWebhookUrl(originFromRequest || undefined),
      pairUrl: getInventoryPairUrl(originFromRequest || undefined),
      setupTokenConfigured: !!getSetupToken(),
    });
  }

  if (route === '/integrations/status' && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!tenantId) return err('Tenant operasional wajib', 400);
    const config = await getIntegrationConfig(db, tenantId);

    let catalogOk = false;
    let catalogCount = 0;
    let vendorTenantCount = 0;
    if (config.salesApiKey) {
      try {
        const apiKey = await getSalesApiKeyForVendor(db, tenantId);
        const headers: Record<string, string> = {};
        if (apiKey) headers['X-Api-Key'] = apiKey;
        const res = await fetch(
          `${config.salesAppUrl}/api/integrations/catalog?allTenants=true`,
          { headers, signal: AbortSignal.timeout(15000) },
        );
        const data = await res.json();
        catalogOk = res.ok && (data.count || 0) > 0;
        catalogCount = data.count || 0;
        vendorTenantCount = (data.availableTenants || []).filter((t) => t.count > 0).length;
        if (res.ok && data.availableTenants?.length) {
          await upsertVendorTenantsFromCatalog(db, tenantId, data.availableTenants);
          await backfillProductVendorNames(db, tenantId);
        }
      } catch {
        catalogOk = false;
      }
    }

    const productCount = await db.collection('products').countDocuments({ tenantId, aktif: { $ne: false } });
    const syncedCount = await db.collection('products').countDocuments({ tenantId, syncSource: 'sales.app' });
    const webhookInbox = await db.collection('webhook_inbox').countDocuments({ tenantId });
    const vendorLinks = await listActiveLinksForCustomer(db, tenantId);

    return ok({
      tenantId,
      ...config,
      salesApiKey: config.salesApiKey ? `${config.salesApiKey.slice(0, 12)}…` : '',
      webhookSecret: config.webhookSecret ? `${config.webhookSecret.slice(0, 8)}…` : '',
      catalogReachable: catalogOk,
      catalogCount,
      vendorTenantCount: Math.max(vendorTenantCount, vendorLinks.length),
      vendorLinks: vendorLinks.map((l) => ({
        vendorTenantId: l.vendorTenantId,
        vendorName: l.vendorName,
        tierHargaDefault: l.tierHargaDefault,
        pairedAt: l.pairedAt,
      })),
      localProductCount: productCount,
      syncedProductCount: syncedCount,
      webhookEventsReceived: webhookInbox,
      tierHargaDefault: config.tierHargaDefault || 'ECER',
      lastCatalogSyncAt: config.lastCatalogSyncAt || null,
      ready: vendorLinks.length > 0 && !!config.salesApiKey && catalogOk && syncedCount > 0,
    });
  }

  if (route === '/integrations/pair' && method === 'POST') {
    const setupToken = getSetupToken();
    if (!setupToken) {
      return err('INTEGRATION_SETUP_TOKEN belum di-set di environment production', 503);
    }
    const token = String(intBody.setupToken || '');
    if (token !== setupToken) return err('Setup token tidak valid', 403);

    const customerTenantId = String(intBody.customerTenantId || '').trim().toLowerCase();
    if (!customerTenantId) return err('customerTenantId wajib', 400);

    const salesApiKey = String(intBody.salesApiKey || '').trim();
    const webhookSecret = String(intBody.webhookSecret || '').trim();
    const vendorTenantId = String(intBody.vendorTenantId || 'default').trim();
    const salesAppUrl = String(intBody.salesAppUrl || 'http://localhost:3000').replace(/\/$/, '');
    if (!salesApiKey || !webhookSecret) return err('salesApiKey dan webhookSecret wajib', 400);

    const now = new Date();
    const link = await upsertIntegrationLink(db, {
      customerTenantId,
      vendorTenantId,
      salesAppUrl,
      salesApiKey,
      webhookSecret,
      vendorName: String(intBody.vendorName || '').trim(),
      tierHargaDefault: String(intBody.tierHargaDefault || 'ECER').toUpperCase(),
    });

    let catalogSync: Record<string, unknown> | null = null;
    if (intBody.autoSyncCatalog !== false) {
      const config = await getIntegrationConfig(db, customerTenantId, vendorTenantId);
      await upsertVendorTenant(
        db,
        customerTenantId,
        vendorTenantId,
        link.vendorName || vendorTenantId,
        link.tierHargaDefault,
      );
      catalogSync = await runCatalogSync(db, customerTenantId, config);
    }

    return ok({
      message: 'Pairing berhasil — vendor ditambahkan ke registry integrasi multi-vendor',
      tenantId: customerTenantId,
      vendorTenantId,
      vendorName: link.vendorName,
      vendorLinkCount: (await listActiveLinksForCustomer(db, customerTenantId)).length,
      catalogSync: catalogSync?.error ? { error: catalogSync.error } : catalogSync,
    });
  }

  if (route === '/integrations/links' && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!tenantId) return err('Tenant operasional wajib', 400);
    const links = await listActiveLinksForCustomer(db, tenantId);
    return ok({
      tenantId,
      count: links.length,
      links: links.map((l) => clean({
        vendorTenantId: l.vendorTenantId,
        vendorName: l.vendorName,
        tierHargaDefault: l.tierHargaDefault,
        pairedAt: l.pairedAt,
        salesAppUrl: l.salesAppUrl,
      })),
    });
  }

  if (route === '/integrations/sync-catalog' && method === 'POST') {
    const { denied, tenantId } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    const config = await getIntegrationConfig(db, tenantId);
    if (!config.salesApiKey) return err('Belum di-pair dengan sales.app', 400);
    const result = await runCatalogSync(db, tenantId, config);
    if ('error' in result && result.error) return err(result.error, 400);
    return ok(result);
  }

  if (route === '/integrations/auto-sync' && method === 'POST') {
    const { denied, tenantId } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    const config = await getIntegrationConfig(db, tenantId);
    if (!config.salesApiKey) {
      return ok({ skipped: true, reason: 'not_paired' });
    }

    const dbRow = await db.collection('integration_settings').findOne({ tenantId });
    const last = dbRow?.lastCatalogSyncAt ? new Date(dbRow.lastCatalogSyncAt).getTime() : 0;
    const force = intBody.force === true;
    if (!force && last && Date.now() - last < AUTO_SYNC_MIN_INTERVAL_MS) {
      return ok({ skipped: true, reason: 'recent', lastCatalogSyncAt: dbRow?.lastCatalogSyncAt ?? null });
    }

    const result = await runCatalogSync(db, tenantId, config);
    if ('error' in result && result.error) {
      // Auto-sync background — sales.app offline bukan error fatal
      if (result.offline) {
        return ok({ skipped: true, reason: 'sales_offline', message: result.error });
      }
      return err(result.error, 400);
    }
    return ok({ ...result, auto: true });
  }

  if (route === '/integrations/vendor-tiers' && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const config = await getIntegrationConfig(db, tenantId);
    const rows = await db.collection('vendor_tenants').find({ tenantId }).toArray();
    const tierMap = Object.fromEntries(
      rows.filter((r) => r.vendorTenantId).map((r) => [r.vendorTenantId, r.tierHargaDefault || 'ECER']),
    );
    return ok({
      tierHargaDefault: config.tierHargaDefault || 'ECER',
      tierMap,
      vendors: rows.map((r) => ({
        vendorTenantId: r.vendorTenantId,
        vendorTenantName: r.vendorTenantName,
        tierHargaDefault: r.tierHargaDefault || 'ECER',
      })),
    });
  }

  return null;
}
