import type { HandlerContext } from '@/types/api/handler';
import { parseHandlerBody } from '@/types/api/handler';
import type { Db } from 'mongodb';
// Pairing & status integrasi dengan sales.app (vendor).

import { ok, err, clean } from '@/lib/api/db';
import { secureCompare } from '@/lib/api/secure-compare';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { getIntegrationConfig, getSetupToken } from '@/lib/api/integration-config';
import { resolveEffectiveSalesAppUrl } from '@/lib/api/sales-app-url';
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
  getJobByIdAccessible,
} from '@/lib/api/bg-jobs';
import { requireMaster } from '@/lib/api/require-auth';
import { handleIntegrationInbound } from '@/lib/api/handlers/integration-inbound';
import { createIntegrationClient } from '@/lib/integration/client';
import { IntegrationError } from '@/lib/integration/errors';
import { randomUUID } from 'node:crypto';

const AUTO_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000;
const PROBE_REFRESH_MS = 60 * 1000;
const PROBE_RUN_TIMEOUT_MS = 60 * 1000;

/** Probe katalog berjalan di background — hasil disimpan untuk stale-while-revalidate. H2: SDK. */
async function refreshCatalogProbe(
  db: Db,
  tenantId: string,
  config: { salesAppUrl?: string },
): Promise<void> {
  const coll = db.collection('integration_probe_status');
  try {
    const apiKey = await getSalesApiKeyForVendor(db, tenantId);
    if (!apiKey || !config.salesAppUrl) throw new Error('not_paired');
    const client = createIntegrationClient(db);
    const data = await client.pullCatalogPage({
      salesAppUrl: config.salesAppUrl,
      apiKey,
      correlationId: randomUUID(),
      query: { limit: 500 },
      timeoutMs: 15_000,
    });
    const count = Number(data.count || 0);
    const tenants = Array.isArray(data.availableTenants)
      ? (data.availableTenants as Array<{ count?: number }>)
      : [];
    await coll.updateOne(
      { tenantId },
      {
        $set: {
          tenantId,
          catalogOk: count > 0,
          catalogCount: count,
          vendorTenantCount: tenants.filter((t) => (t.count || 0) > 0).length,
          probedAt: new Date(),
          running: false,
        },
      },
      { upsert: true },
    );
  } catch {
    await coll.updateOne(
      { tenantId },
      {
        $set: {
          tenantId,
          catalogOk: false,
          catalogCount: 0,
          vendorTenantCount: 0,
          probedAt: new Date(),
          running: false,
        },
      },
      { upsert: true },
    );
  }
}

/**
 * Fail-fast gate: do not enqueue CATALOG_SYNC when unpaired or Sales rejects auth.
 * Prevents AUTH poison jobs that land in DLQ on attempt 1. H2: SDK.
 */
async function probeCatalogAuth(
  db: Db,
  tenantId: string,
  config: { salesAppUrl?: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_paired' | 'unauthorized' | 'unreachable'; error?: string }> {
  if (!config.salesAppUrl) {
    return { ok: false, reason: 'not_paired', error: 'salesAppUrl belum di-set' };
  }
  const apiKey = await getSalesApiKeyForVendor(db, tenantId);
  if (!apiKey) {
    return { ok: false, reason: 'not_paired', error: 'Belum di-pair dengan sales.app' };
  }
  try {
    const client = createIntegrationClient(db);
    await client.pullCatalogPage({
      salesAppUrl: config.salesAppUrl,
      apiKey,
      correlationId: randomUUID(),
      query: { limit: 1 },
      timeoutMs: 10_000,
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof IntegrationError) {
      if (e.httpStatus === 401 || e.httpStatus === 403) {
        return { ok: false, reason: 'unauthorized', error: `Sales.app HTTP ${e.httpStatus}` };
      }
      // Non-auth / network: still enqueue so worker can retry (TRANSIENT).
      return { ok: true };
    }
    return { ok: true };
  }
}

async function enqueueCatalogSync(db: Db, tenantId: string) {
  const config = await getIntegrationConfig(db, tenantId);
  if (!config.salesApiKey) {
    return { skipped: true as const, reason: 'not_paired' as const, error: 'Belum di-pair dengan sales.app' };
  }
  const probe = await probeCatalogAuth(db, tenantId, config);
  if (!probe.ok && (probe.reason === 'not_paired' || probe.reason === 'unauthorized')) {
    return { skipped: true as const, reason: probe.reason, error: probe.error };
  }

  const existing = await db.collection('bg_jobs').findOne({
    tenantId,
    type: JOB_TYPES.CATALOG_SYNC,
    status: { $in: ['PENDING', 'RUNNING'] },
  });
  if (existing) return { jobId: String(existing.id), reused: true as const };
  const { jobId } = await enqueueJob(db, { type: JOB_TYPES.CATALOG_SYNC, tenantId, payload: {} });
  scheduleJobProcessing(db, { limit: 1 });
  return { jobId, reused: false as const };
}

export async function handleIntegrations({
  db, route, method, body, auth, url, request, path,
}: HandlerContext) {
  const inbound = await handleIntegrationInbound({ db, route, method, body, auth, url, request, path });
  if (inbound) return inbound;

  const intBody = parseHandlerBody(body);
  const scopeOpts = { url, body: intBody, request };
  if (route === '/integrations/status' && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!tenantId) return err('Tenant operasional wajib', 400);
    const config = await getIntegrationConfig(db, tenantId);
    const probe = url.searchParams.get('probe') === '1';

    // Stale-while-revalidate: balas dengan hasil probe tersimpan (instan),
    // lalu jalankan probe baru di background jika sudah basi.
    let catalogOk: boolean | null = null;
    let catalogCount = 0;
    let vendorTenantCount = 0;
    let probedAt: Date | null = null;
    let probeRunning = false;
    if (probe && config.salesApiKey) {
      const probeColl = db.collection('integration_probe_status');
      const cached = await probeColl.findOne({ tenantId });
      if (cached) {
        catalogOk = cached.catalogOk === true;
        catalogCount = Number(cached.catalogCount || 0);
        vendorTenantCount = Number(cached.vendorTenantCount || 0);
        probedAt = cached.probedAt ? new Date(cached.probedAt) : null;
      }
      const stale = !probedAt || Date.now() - probedAt.getTime() > PROBE_REFRESH_MS;
      const runningStuck = cached?.running === true
        && cached?.runStartedAt
        && Date.now() - new Date(cached.runStartedAt).getTime() > PROBE_RUN_TIMEOUT_MS;
      if (stale && (cached?.running !== true || runningStuck)) {
        // Klaim atomik agar hanya satu probe berjalan per tenant.
        const claim = await probeColl.updateOne(
          { tenantId, ...(runningStuck ? {} : { running: { $ne: true } }) },
          { $set: { tenantId, running: true, runStartedAt: new Date() } },
          { upsert: !cached },
        );
        if (claim.modifiedCount > 0 || claim.upsertedCount > 0) {
          probeRunning = true;
          setImmediate(() => {
            refreshCatalogProbe(db, tenantId, config).catch(() => {});
          });
        }
      } else if (cached?.running === true) {
        probeRunning = true;
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
      catalogProbed: probe && probedAt != null,
      catalogProbedAt: probedAt,
      catalogProbeRunning: probeRunning,
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

  if (route === '/integrations/platform-pair' && method === 'POST') {
    const setupToken = getSetupToken();
    if (!setupToken) {
      return err('INTEGRATION_SETUP_TOKEN belum di-set di environment production', 503);
    }
    const token = String(intBody.setupToken || '');
    if (!secureCompare(token, setupToken)) return err('Setup token tidak valid', 403);

    const { runPlatformPair } = await import('@/lib/api/platform-pair');
    const result = await runPlatformPair(db, {
      customerTenantId: String(intBody.customerTenantId || ''),
      salesAppUrl: resolveEffectiveSalesAppUrl(String(intBody.salesAppUrl || '')),
      salesApiKey: String(intBody.salesApiKey || ''),
      webhookSecret: String(intBody.webhookSecret || ''),
      autoSyncCatalog: intBody.autoSyncCatalog !== false,
      vendors: Array.isArray(intBody.vendors)
        ? (intBody.vendors as Array<Record<string, unknown>>).map((v) => ({
          vendorTenantId: String(v.vendorTenantId || ''),
          vendorName: String(v.vendorName || ''),
          tierHargaDefault: String(v.tierHargaDefault || 'GROSIR'),
        }))
        : [],
    });
    if ('error' in result && result.error) return err(String(result.error), 400);
    return ok(result);
  }

  if (route === '/integrations/connect-sales' && method === 'POST') {
    const { denied, tenantId } = resolveOperationalScope(auth, scopeOpts);
    if (denied) return denied;
    if (!tenantId) return err('Tenant operasional wajib', 400);

    const links = await listActiveLinksForCustomer(db, tenantId);
    const config = await getIntegrationConfig(db, tenantId);
    if (!links.length && !config.salesApiKey) {
      return err(
        'Belum terhubung — jalankan Hubungkan Platform dari sales.app (menu Integrasi, role MASTER)',
        400,
      );
    }

    const enqueued = await enqueueCatalogSync(db, tenantId);
    if ('skipped' in enqueued && enqueued.skipped) {
      return err(String(enqueued.error || 'Catalog sync ditolak'), 400);
    }
    scheduleJobProcessing(db, { limit: 1 });
    return ok({
      message: 'Terhubung ke sales.app — sync katalog dimulai',
      jobId: enqueued.jobId,
      async: true,
      reused: enqueued.reused,
      vendorLinkCount: links.length,
      status: enqueued.reused ? 'RUNNING' : 'PENDING',
    }, 202);
  }

  if (route === '/integrations/pair' && method === 'POST') {
    const setupToken = getSetupToken();
    if (!setupToken) {
      return err('INTEGRATION_SETUP_TOKEN belum di-set di environment production', 503);
    }
    const token = String(intBody.setupToken || '');
    if (!secureCompare(token, setupToken)) return err('Setup token tidak valid', 403);

    const customerTenantId = String(intBody.customerTenantId || '').trim().toLowerCase();
    if (!customerTenantId) return err('customerTenantId wajib', 400);

    const salesApiKey = String(intBody.salesApiKey || '').trim();
    const webhookSecret = String(intBody.webhookSecret || '').trim();
    const vendorTenantId = String(intBody.vendorTenantId || 'default').trim();
    const salesAppUrl = resolveEffectiveSalesAppUrl(String(intBody.salesAppUrl || ''));
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
      const enqueued = await enqueueCatalogSync(db, customerTenantId);
      if ('skipped' in enqueued && enqueued.skipped) {
        catalogSync = { skipped: true, reason: enqueued.reason, error: enqueued.error };
      } else {
        catalogSync = {
          jobId: enqueued.jobId,
          async: true,
          status: enqueued.reused ? 'RUNNING' : 'PENDING',
          reused: enqueued.reused,
        };
        scheduleJobProcessing(db, { limit: 1 });
      }
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
    const enqueued = await enqueueCatalogSync(db, tenantId);
    if ('skipped' in enqueued && enqueued.skipped) {
      return err(String(enqueued.error || 'Catalog sync ditolak'), 400);
    }
    return ok({
      jobId: enqueued.jobId,
      async: true,
      status: enqueued.reused ? 'RUNNING' : 'PENDING',
      reused: enqueued.reused,
    }, 202);
  }

  if (path[0] === 'integrations' && path[1] === 'jobs' && path[2] && path[3] === 'stream' && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const jobId = path[2];
    const { createBgJobStreamResponse } = await import('@/lib/api/bg-job-stream');
    return createBgJobStreamResponse(async () => {
      const job = await getJobByIdAccessible(db, jobId, auth, tenantId);
      return job as Record<string, unknown> | null;
    });
  }

  if (path[0] === 'integrations' && path[1] === 'jobs' && path[2] && method === 'GET') {
    const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const job = await getJobByIdAccessible(db, path[2], auth, tenantId);
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

    const enqueued = await enqueueCatalogSync(db, tenantId);
    if ('skipped' in enqueued && enqueued.skipped) {
      return ok({ skipped: true, reason: enqueued.reason, error: enqueued.error });
    }
    return ok({
      jobId: enqueued.jobId,
      async: true,
      auto: true,
      reused: enqueued.reused,
      status: enqueued.reused ? 'RUNNING' : 'PENDING',
    }, 202);
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

  if (route === '/integrations/reconcile/latest' && method === 'GET') {
    const denied = requireMaster(auth);
    if (denied) return denied;
    const report = await db.collection('integration_reconcile_reports')
      .find({})
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    const latest = report[0];
    if (!latest) return ok({ report: null, message: 'Belum ada laporan reconcile' });
    return ok(clean(latest));
  }

  return null;
}
