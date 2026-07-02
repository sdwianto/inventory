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
import { upsertVendorTenant } from '@/lib/api/vendor-tenants';
import { runCatalogSync } from '@/lib/api/catalog-sync-run';
import {
  enqueueJob,
  JOB_TYPES,
  scheduleJobProcessing,
  getJobById,
} from '@/lib/api/bg-jobs';

const AUTO_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000;

async function enqueueCatalogSync(db: Db, tenantId: string) {
  const existing = await db.collection('bg_jobs').findOne({
    tenantId,
    type: JOB_TYPES.CATALOG_SYNC,
    status: { $in: ['PENDING', 'RUNNING'] },
  });
  if (existing) return { jobId: String(existing.id), reused: true };
  const { jobId } = await enqueueJob(db, { type: JOB_TYPES.CATALOG_SYNC, tenantId, payload: {} });
  scheduleJobProcessing(db, { limit: 1 });
  return { jobId, reused: false };
}

export async function handleIntegrations({
  db, route, method, body, auth, url, request, path,
}: HandlerContext) {
  const intBody = parseHandlerBody(body);
  const scopeOpts = { url, body: intBody, request };
  if (route === '/integrations/status' && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!tenantId) return err('Tenant operasional wajib', 400);
    const config = await getIntegrationConfig(db, tenantId);
    const probe = url.searchParams.get('probe') === '1';

    let catalogOk: boolean | null = null;
    let catalogCount = 0;
    let vendorTenantCount = 0;
    if (probe && config.salesApiKey) {
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
        vendorTenantCount = (data.availableTenants || []).filter((t: { count?: number }) => (t.count || 0) > 0).length;
      } catch {
        catalogOk = false;
      }
    }

    const [productCount, syncedCount, webhookInbox, vendorLinks] = await Promise.all([
      db.collection('products').countDocuments({ tenantId, aktif: { $ne: false } }),
      db.collection('products').countDocuments({ tenantId, syncSource: 'sales.app' }),
      db.collection('webhook_inbox').countDocuments({ tenantId }),
      listActiveLinksForCustomer(db, tenantId),
    ]);

    return ok({
      tenantId,
      ...config,
      salesApiKey: config.salesApiKey ? `${config.salesApiKey.slice(0, 12)}…` : '',
      webhookSecret: config.webhookSecret ? `${config.webhookSecret.slice(0, 8)}…` : '',
      catalogReachable: catalogOk,
      catalogProbed: probe,
      catalogCount: probe ? catalogCount : undefined,
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
      ready: vendorLinks.length > 0 && !!config.salesApiKey && syncedCount > 0,
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
      await upsertVendorTenant(
        db,
        customerTenantId,
        vendorTenantId,
        link.vendorName || vendorTenantId,
        link.tierHargaDefault,
      );
      const { jobId, reused } = await enqueueCatalogSync(db, customerTenantId);
      catalogSync = { jobId, async: true, status: reused ? 'RUNNING' : 'PENDING', reused };
      scheduleJobProcessing(db, { limit: 1 });
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
    if (!tenantId) return err('Scope tidak valid', 400);
    const config = await getIntegrationConfig(db, tenantId);
    if (!config.salesApiKey) return err('Belum di-pair dengan sales.app', 400);
    const inline = intBody.inline === true || url.searchParams.get('inline') === '1';
    if (inline) {
      const result = await runCatalogSync(db, tenantId, config);
      if ('error' in result && result.error) return err(String(result.error), 400);
      return ok(result);
    }
    const { jobId, reused } = await enqueueCatalogSync(db, tenantId);
    return ok({ jobId, async: true, status: reused ? 'RUNNING' : 'PENDING', reused }, 202);
  }

  if (path[0] === 'integrations' && path[1] === 'jobs' && path[2] && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const job = await getJobById(db, path[2], tenantId);
    if (!job) return err('Job tidak ditemukan', 404);
    return ok(clean(job));
  }

  if (route === '/integrations/auto-sync' && method === 'POST') {
    const { denied, tenantId } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    if (!tenantId) return err('Scope tidak valid', 400);
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

    const { jobId, reused } = await enqueueCatalogSync(db, tenantId);
    return ok({ jobId, async: true, auto: true, reused, status: reused ? 'RUNNING' : 'PENDING' }, 202);
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
