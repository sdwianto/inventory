// Pairing & status integrasi dengan sales.app (vendor).

import { ok, err, clean } from '@/lib/api/db';
import { requireAuth } from '@/lib/api/require-auth';
import { getIntegrationConfig, getSetupToken } from '@/lib/api/integration-config';
import { upsertProductFromVendor } from '@/lib/api/product-sync';

async function runCatalogSync(db, tenantId, config) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.salesApiKey) headers['X-Api-Key'] = config.salesApiKey;

  const res = await fetch(
    `${config.salesAppUrl}/api/integrations/catalog?vendorTenantId=${encodeURIComponent(config.vendorTenantId)}`,
    { headers, signal: AbortSignal.timeout(20000) },
  );
  const data = await res.json();
  if (!res.ok) return { error: data.error || `Sales.app ${res.status}` };

  const products = data.products || [];
  if (!products.length) {
    const hint = (data.availableTenants || []).map((t) => `${t.tenantId}(${t.count})`).join(', ');
    return { error: hint ? `Katalog kosong. Produk ada di: ${hint}` : 'Katalog kosong di sales.app' };
  }

  const vendorTenantId = data.vendorTenantId || config.vendorTenantId;
  const results = { created: 0, updated: 0, errors: [] };
  for (const p of products) {
    try {
      const r = await upsertProductFromVendor(db, tenantId, vendorTenantId, p);
      if (r.action === 'created') results.created += 1;
      else results.updated += 1;
    } catch (e) {
      results.errors.push({ kode: p.kode, error: e.message });
    }
  }

  // Pastikan produk yang punya vendor map selalu punya flag sync (perbaiki data lama)
  const now = new Date();
  const maps = await db.collection('vendor_product_map').find({ tenantId }).toArray();
  let repaired = 0;
  for (const m of maps) {
    if (!m.localStokId) continue;
    const r = await db.collection('products').updateOne(
      {
        id: m.localStokId,
        tenantId,
        $or: [
          { syncSource: { $ne: 'sales.app' } },
          { vendorStokId: { $in: [null, ''] } },
          { vendorStokId: { $exists: false } },
        ],
      },
      {
        $set: {
          syncSource: 'sales.app',
          vendorStokId: m.vendorStokId,
          vendorTenantId: m.vendorTenantId || vendorTenantId,
          updatedAt: now,
        },
      },
    );
    if (r.modifiedCount) repaired += 1;
  }

  return { ...results, total: products.length, vendorTenantId, repaired };
}

export async function handleIntegrations({ db, route, method, body, auth }) {
  if (route === '/integrations/status' && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const tenantId = auth.tenantId || 'default';
    const config = await getIntegrationConfig(db, tenantId);

    let catalogOk = false;
    let catalogCount = 0;
    if (config.salesApiKey) {
      try {
        const headers = { 'X-Api-Key': config.salesApiKey };
        const res = await fetch(
          `${config.salesAppUrl}/api/integrations/catalog?vendorTenantId=${encodeURIComponent(config.vendorTenantId)}`,
          { headers, signal: AbortSignal.timeout(8000) },
        );
        const data = await res.json();
        catalogOk = res.ok && (data.count || 0) > 0;
        catalogCount = data.count || 0;
      } catch {
        catalogOk = false;
      }
    }

    const productCount = await db.collection('products').countDocuments({ tenantId, aktif: { $ne: false } });
    const webhookInbox = await db.collection('webhook_inbox').countDocuments({ tenantId });

    return ok({
      tenantId,
      ...config,
      salesApiKey: config.salesApiKey ? `${config.salesApiKey.slice(0, 12)}…` : '',
      catalogReachable: catalogOk,
      catalogCount,
      localProductCount: productCount,
      webhookEventsReceived: webhookInbox,
      ready: !!config.salesApiKey && !!config.webhookSecret && catalogOk && productCount > 0,
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
      catalogSync = await runCatalogSync(db, customerTenantId, config);
    }

    return ok({
      message: 'Pairing berhasil — konfigurasi tersimpan',
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

  return null;
}
