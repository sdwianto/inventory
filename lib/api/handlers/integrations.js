// Pairing & status integrasi dengan sales.app (vendor).

import { ok, err, clean } from '@/lib/api/db';
import { requireAuth } from '@/lib/api/require-auth';
import { getIntegrationConfig, getSetupToken } from '@/lib/api/integration-config';
import { upsertProductFromVendor } from '@/lib/api/product-sync';
import {
  upsertVendorTenant,
  upsertVendorTenantsFromCatalog,
  backfillProductVendorNames,
} from '@/lib/api/vendor-tenants';
import { syncVendorTiersFromSales } from '@/lib/api/vendor-tier-sync';

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

async function runCatalogSync(db, tenantId, config) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.salesApiKey) headers['X-Api-Key'] = config.salesApiKey;

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

  const results = { created: 0, updated: 0, errors: [], byVendor: {} };
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
      results.errors.push({ kode: p.kode, vendorTenantId: vTenant, error: e.message });
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

export async function handleIntegrations({ db, route, method, body, auth }) {
  if (route === '/integrations/status' && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const tenantId = auth.tenantId || 'default';
    const config = await getIntegrationConfig(db, tenantId);

    let catalogOk = false;
    let catalogCount = 0;
    let vendorTenantCount = 0;
    if (config.salesApiKey) {
      try {
        const headers = { 'X-Api-Key': config.salesApiKey };
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

    return ok({
      tenantId,
      ...config,
      salesApiKey: config.salesApiKey ? `${config.salesApiKey.slice(0, 12)}…` : '',
      catalogReachable: catalogOk,
      catalogCount,
      vendorTenantCount,
      localProductCount: productCount,
      syncedProductCount: syncedCount,
      webhookEventsReceived: webhookInbox,
      tierHargaDefault: config.tierHargaDefault || 'ECER',
      lastCatalogSyncAt: config.lastCatalogSyncAt || null,
      ready: !!config.salesApiKey && !!config.webhookSecret && catalogOk && syncedCount > 0,
    });
  }

  if (route === '/integrations/pair' && method === 'POST') {
    const token = body?.setupToken || '';
    if (token !== getSetupToken()) return err('Setup token tidak valid', 403);

    const customerTenantId = String(body?.customerTenantId || '').trim().toLowerCase();
    if (!customerTenantId) return err('customerTenantId wajib', 400);

    const salesApiKey = String(body?.salesApiKey || '').trim();
    const webhookSecret = String(body?.webhookSecret || '').trim();
    const vendorTenantId = String(body?.vendorTenantId || 'default').trim();
    const salesAppUrl = String(body?.salesAppUrl || 'http://localhost:3000').replace(/\/$/, '');
    if (!salesApiKey || !webhookSecret) return err('salesApiKey dan webhookSecret wajib', 400);

    const now = new Date();
    const doc = {
      tenantId: customerTenantId,
      customerTenantId,
      salesAppUrl,
      salesApiKey,
      vendorTenantId,
      webhookSecret,
      vendorName: String(body?.vendorName || '').trim(),
      tierHargaDefault: String(body?.tierHargaDefault || 'ECER').toUpperCase(),
      pairedAt: now,
      updatedAt: now,
    };

    await db.collection('integration_settings').updateOne(
      { tenantId: customerTenantId },
      { $set: doc, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );

    let catalogSync = null;
    if (body?.autoSyncCatalog !== false) {
      const config = await getIntegrationConfig(db, customerTenantId);
      await upsertVendorTenant(
        db,
        customerTenantId,
        vendorTenantId,
        doc.vendorName || vendorTenantId,
        doc.tierHargaDefault,
      );
      catalogSync = await runCatalogSync(db, customerTenantId, config);
    }

    return ok({
      message: 'Pairing berhasil — katalog global di-sync ke inventory',
      tenantId: customerTenantId,
      vendorTenantId,
      vendorName: doc.vendorName,
      catalogSync: catalogSync?.error ? { error: catalogSync.error } : catalogSync,
    });
  }

  if (route === '/integrations/sync-catalog' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const tenantId = auth.tenantId || 'default';
    const config = await getIntegrationConfig(db, tenantId);
    if (!config.salesApiKey) return err('Belum di-pair dengan sales.app', 400);
    const result = await runCatalogSync(db, tenantId, config);
    if (result.error) return err(result.error, 400);
    return ok(result);
  }

  if (route === '/integrations/auto-sync' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const tenantId = auth.tenantId || 'default';
    const config = await getIntegrationConfig(db, tenantId);
    if (!config.salesApiKey) {
      return ok({ skipped: true, reason: 'not_paired' });
    }

    const dbRow = await db.collection('integration_settings').findOne({ tenantId });
    const last = dbRow?.lastCatalogSyncAt ? new Date(dbRow.lastCatalogSyncAt).getTime() : 0;
    const force = body?.force === true;
    if (!force && last && Date.now() - last < AUTO_SYNC_MIN_INTERVAL_MS) {
      return ok({ skipped: true, reason: 'recent', lastCatalogSyncAt: dbRow.lastCatalogSyncAt });
    }

    const result = await runCatalogSync(db, tenantId, config);
    if (result.error) {
      // Auto-sync background — sales.app offline bukan error fatal
      if (result.offline) {
        return ok({ skipped: true, reason: 'sales_offline', message: result.error });
      }
      return err(result.error, 400);
    }
    return ok({ ...result, auto: true });
  }

  if (route === '/integrations/vendor-tiers' && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const tenantId = auth.tenantId || 'default';
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
