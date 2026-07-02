import type { Db } from 'mongodb';
// Antrian job background — invoice GRN, dll. (MongoDB-backed).

import { v4 as uuidv4 } from 'uuid';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { notifyGrnPostedToSales } from '@/lib/api/grn-notify-sales';
import { runCatalogSync } from '@/lib/api/catalog-sync-run';
import { runHutangSyncPending } from '@/lib/api/hutang-sync-pending-run';
import { runPoVendorSyncPending } from '@/lib/api/po-vendor-sync-run';
import { processWebhookInboxEvent } from '@/lib/api/webhook-inbox-process';
import { runGrnSyncShipped } from '@/lib/api/grn-sync-shipped-run';
import { runGrnPostSideEffects } from '@/lib/api/grn-post-side-effects-run';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import type { GrnDoc } from '@/types/documents';
import type { JsonObject } from '@/types/json';

export const JOB_TYPES = {
  GRN_INVOICE_SYNC: 'GRN_INVOICE_SYNC',
  CATALOG_SYNC: 'CATALOG_SYNC',
  HUTANG_SYNC: 'HUTANG_SYNC',
  PO_VENDOR_SYNC: 'PO_VENDOR_SYNC',
  WEBHOOK_INBOX: 'WEBHOOK_INBOX',
  GRN_SYNC_SHIPPED: 'GRN_SYNC_SHIPPED',
  GRN_POST_SIDE_EFFECTS: 'GRN_POST_SIDE_EFFECTS',
} as const;

const MAX_ATTEMPTS = 3;

let indexesEnsured = false;

type BgJob = JsonObject & {
  id: string;
  type: string;
  tenantId: string;
  grnId?: string | null;
  payload?: JsonObject;
  status: string;
  attempts?: number;
};

export async function ensureBgJobIndexes(db: Db) {
  if (indexesEnsured) return;
  try {
    await db.collection('bg_jobs').createIndex(
      { status: 1, createdAt: 1 },
      { name: 'idx_bg_jobs_status_created' },
    );
    await db.collection('bg_jobs').createIndex(
      { grnId: 1, type: 1 },
      { name: 'idx_bg_jobs_grn_type' },
    );
    await db.collection('bg_jobs').createIndex(
      { type: 1, tenantId: 1, status: 1 },
      { name: 'idx_bg_jobs_type_tenant_status' },
    );
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (err?.code !== 85 && err?.code !== 86) console.warn('bg_jobs index:', err.message);
  }
  indexesEnsured = true;
}

export async function enqueueJob(
  db: Db,
  { type, tenantId, grnId, payload = {} }: {
    type: string;
    tenantId?: string;
    grnId?: string | null;
    payload?: JsonObject;
  },
) {
  await ensureBgJobIndexes(db);
  const tid = normalizeTenantId(tenantId || 'default');
  const now = new Date();

  const dedupeKey = payload.dedupeKey ? String(payload.dedupeKey) : null;
  let existing = grnId
    ? await db.collection('bg_jobs').findOne({
      type,
      grnId,
      status: { $in: ['PENDING', 'RUNNING'] },
    })
    : null;
  if (!existing && dedupeKey) {
    existing = await db.collection('bg_jobs').findOne({
      type,
      tenantId: tid,
      status: { $in: ['PENDING', 'RUNNING'] },
      'payload.dedupeKey': dedupeKey,
    });
  }
  if (!existing && !grnId && !dedupeKey && type !== JOB_TYPES.GRN_INVOICE_SYNC) {
    existing = await db.collection('bg_jobs').findOne({
      type,
      tenantId: tid,
      status: { $in: ['PENDING', 'RUNNING'] },
    });
  }
  if (existing) return { jobId: String(existing.id), reused: true };

  const job = {
    id: uuidv4(),
    type,
    tenantId: tid,
    grnId: grnId || null,
    payload,
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    result: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  await db.collection('bg_jobs').insertOne(job);
  return { jobId: job.id, reused: false };
}

async function setGrnInvoiceSync(db: Db, grnId: string | null | undefined, patch: Record<string, unknown>) {
  if (!grnId) return;
  await db.collection('goods_receipts').updateOne(
    { id: grnId },
    { $set: { ...patch, updatedAt: new Date() } },
  );
}

export async function runGrnInvoiceSyncJob(db: Db, job: BgJob) {
  const grn = await db.collection('goods_receipts').findOne({ id: job.grnId }) as GrnDoc | null;
  if (!grn) return { error: 'GRN tidak ditemukan' };
  if (grn.status !== 'POSTED') return { error: 'GRN belum POSTED' };

  await setGrnInvoiceSync(db, grn.id, {
    invoiceSyncStatus: 'SYNCING',
    invoiceSyncError: null,
  });

  const result = await notifyGrnPostedToSales(db, job.tenantId, grn) as Record<string, unknown>;

  if ('error' in result && result.error) {
    await setGrnInvoiceSync(db, grn.id, {
      invoiceSyncStatus: 'FAILED',
      invoiceSyncError: result.error,
      invoiceSyncAt: new Date(),
    });
    return { error: result.error, result };
  }

  if (result.skipped) {
    await setGrnInvoiceSync(db, grn.id, {
      invoiceSyncStatus: 'SKIPPED',
      invoiceSyncError: result.reason || null,
      invoiceSyncAt: new Date(),
    });
    return { skipped: true, result };
  }

  const patch: Record<string, unknown> = {
    invoiceSyncStatus: 'DONE',
    invoiceSyncError: null,
    invoiceSyncAt: new Date(),
  };
  if (result.noInvoice) patch.noInvoice = result.noInvoice;
  if (result.invoiceId) patch.vendorInvoiceId = result.invoiceId;
  await setGrnInvoiceSync(db, grn.id, patch);

  return { ok: true, result };
}

async function runCatalogSyncJob(db: Db, job: BgJob) {
  const config = await getIntegrationConfig(db, job.tenantId);
  if (!config.salesApiKey) return { error: 'Belum di-pair dengan sales.app' };
  const result = await runCatalogSync(db, job.tenantId, config);
  if ('error' in result && result.error) {
    return { error: result.error, offline: Boolean(result.offline) };
  }
  return result;
}

async function runHutangSyncJob(db: Db, job: BgJob) {
  const replaySales = job.payload?.replaySales === true;
  const scopeAuth = { tenantId: job.tenantId } as import('@/types/auth').AuthContext;
  return runHutangSyncPending(db, job.tenantId, scopeAuth, { replaySales });
}

async function runPoVendorSyncJob(db: Db, job: BgJob) {
  const scopeAuth = { tenantId: job.tenantId } as import('@/types/auth').AuthContext;
  return runPoVendorSyncPending(db, scopeAuth);
}

async function runWebhookInboxJob(db: Db, job: BgJob) {
  const { event, payload, customerTenantId, vendorTenantId, dedupeKey } = job.payload || {};
  if (!event || !payload || !customerTenantId) {
    return { error: 'Payload webhook tidak lengkap' };
  }

  let result: Record<string, unknown>;
  let status = 'PROCESSED';
  let processError: string | null = null;

  try {
    result = await processWebhookInboxEvent(db, {
      event: String(event),
      payload: payload as JsonObject,
      customerTenantId: String(customerTenantId),
      vendorTenantId: vendorTenantId ? String(vendorTenantId) : undefined,
    });
  } catch (e) {
    status = 'FAILED';
    processError = e instanceof Error ? e.message : String(e);
    result = { error: processError };
  }

  if (dedupeKey) {
    await db.collection('webhook_inbox').updateOne(
      { dedupeKey: String(dedupeKey) },
      {
        $set: {
          status,
          result,
          processError,
          processedAt: new Date(),
        },
      },
    );
  }

  if (status === 'FAILED') return { error: processError, result };
  return { ok: true, result };
}

export async function getJobById(db: Db, jobId: string, tenantId?: string | null) {
  const filter: Record<string, unknown> = { id: jobId };
  if (tenantId) filter.tenantId = normalizeTenantId(tenantId);
  return db.collection('bg_jobs').findOne(filter);
}

export async function processJob(db: Db, job: BgJob) {
  const now = new Date();
  await db.collection('bg_jobs').updateOne(
    { id: job.id },
    {
      $set: { status: 'RUNNING', startedAt: now, updatedAt: now },
      $inc: { attempts: 1 },
    },
  );

  let outcome: Record<string, unknown>;
  try {
    if (job.type === JOB_TYPES.GRN_INVOICE_SYNC) {
      outcome = await runGrnInvoiceSyncJob(db, job);
    } else if (job.type === JOB_TYPES.CATALOG_SYNC) {
      outcome = await runCatalogSyncJob(db, job);
    } else if (job.type === JOB_TYPES.HUTANG_SYNC) {
      outcome = await runHutangSyncJob(db, job);
    } else if (job.type === JOB_TYPES.PO_VENDOR_SYNC) {
      outcome = await runPoVendorSyncJob(db, job);
    } else if (job.type === JOB_TYPES.WEBHOOK_INBOX) {
      outcome = await runWebhookInboxJob(db, job);
    } else if (job.type === JOB_TYPES.GRN_SYNC_SHIPPED) {
      outcome = await runGrnSyncShipped(db, job.tenantId);
    } else if (job.type === JOB_TYPES.GRN_POST_SIDE_EFFECTS) {
      outcome = await runGrnPostSideEffects(db, job.tenantId, String(job.grnId || job.payload?.grnId || ''));
    } else {
      outcome = { error: `Unknown job type: ${job.type}` };
    }
  } catch (e) {
    outcome = { error: e instanceof Error ? e.message : String(e) };
  }

  const failed = 'error' in outcome && outcome.error;
  await db.collection('bg_jobs').updateOne(
    { id: job.id },
    {
      $set: {
        status: failed ? 'FAILED' : 'DONE',
        lastError: failed ? ('error' in outcome ? outcome.error : null) : null,
        result: outcome,
        finishedAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );

  return outcome;
}

export async function processPendingJobs(
  db: Db,
  { limit = 5, types = null }: { limit?: number; types?: string[] | null } = {},
) {
  await ensureBgJobIndexes(db);
  const filter: Record<string, unknown> = { status: 'PENDING' };
  if (types?.length) filter.type = { $in: types };

  const jobs = await db.collection('bg_jobs')
    .find(filter)
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();

  const results: Record<string, unknown>[] = [];
  for (const jobRow of jobs) {
    const job = jobRow as unknown as BgJob;
    if ((job.attempts || 0) >= MAX_ATTEMPTS) {
      await db.collection('bg_jobs').updateOne(
        { id: job.id },
        { $set: { status: 'FAILED', lastError: 'Max attempts exceeded', updatedAt: new Date() } },
      );
      continue;
    }
    results.push({ jobId: job.id, ...(await processJob(db, job)) });
  }
  return results;
}

/** Fire-and-forget — Node server melanjutkan setelah response terkirim. */
export function scheduleJobProcessing(db: Db, { limit = 3 }: { limit?: number } = {}) {
  setImmediate(() => {
    processPendingJobs(db, { limit }).catch((e) => {
      console.warn('[bg-jobs] process error:', e instanceof Error ? e.message : e);
    });
  });
}

export async function getJobStatusForGrn(db: Db, grnId: string) {
  const job = await db.collection('bg_jobs')
    .find({ grnId, type: JOB_TYPES.GRN_INVOICE_SYNC })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  return job || null;
}
