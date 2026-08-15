import type { Db } from 'mongodb';
// Antrian job background — invoice GRN, dll. (MongoDB-backed).

import { v4 as uuidv4 } from 'uuid';
import {
  enqueue as executionEnqueue,
  mapLegacyEnqueueInput,
} from '@/lib/execution/queue/enqueue';
import {
  ensureExecutionJobIndexes,
} from '@/lib/execution/queue/indexes';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { shouldUseExecutionEnqueue, shouldUseLegacyBgPoll } from '@/lib/api/execution-wave';
import {
  executeCancelSoPushRecoveryJob,
  executeCatalogSyncJob,
  executeHutangSyncJob,
  executePoVendorSyncJob,
  executeWebhookInboxJob,
} from '@/lib/api/inventory-execution-handlers';
import type { GrnDoc } from '@/types/documents';
import type { JsonObject } from '@/types/json';
import { drainEnsureGrnInvoice } from '@/lib/api/integration-outbox';
import { runGrnSyncShipped } from '@/lib/api/grn-sync-shipped-run';
import { runGrnPostSideEffects } from '@/lib/api/grn-post-side-effects-run';

export const JOB_TYPES = {
  GRN_INVOICE_SYNC: 'GRN_INVOICE_SYNC',
  GOODS_RETURN_CN_SYNC: 'GOODS_RETURN_CN_SYNC',
  CATALOG_SYNC: 'CATALOG_SYNC',
  HUTANG_SYNC: 'HUTANG_SYNC',
  PO_VENDOR_SYNC: 'PO_VENDOR_SYNC',
  CANCEL_SO_PUSH_RECOVERY: 'CANCEL_SO_PUSH_RECOVERY',
  WEBHOOK_INBOX: 'WEBHOOK_INBOX',
  GRN_SYNC_SHIPPED: 'GRN_SYNC_SHIPPED',
  GRN_POST_SIDE_EFFECTS: 'GRN_POST_SIDE_EFFECTS',
  GRN_RESOLVE_PRODUCTS: 'GRN_RESOLVE_PRODUCTS',
  HUTANG_REPAIR: 'HUTANG_REPAIR',
  HUTANG_BACKFILL: 'HUTANG_BACKFILL',
  INTEGRATION_RECONCILE: 'INTEGRATION_RECONCILE',
  SANDBOX_RESET: 'SANDBOX_RESET',
  AUDIT_LOG_PURGE: 'AUDIT_LOG_PURGE',
} as const;

const MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 30_000;
export const STALE_RUNNING_MS = 15 * 60 * 1000;

/** Backoff eksponensial: 30s, 60s, 120s. */
function retryDelayMs(attempts: number): number {
  return BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempts - 1));
}

let indexesEnsured = false;

type BgJob = JsonObject & {
  id: string;
  type: string;
  tenantId: string;
  grnId?: string | null;
  payload?: JsonObject;
  status: string;
  attempts?: number;
  jobSchemaVersion?: number;
};

function isPlatformManagedJob(job: BgJob): boolean {
  return job.jobSchemaVersion != null;
}

export async function ensureBgJobIndexes(db: Db) {
  if (indexesEnsured) return;
  try {
    await db.collection('bg_jobs').createIndex(
      { status: 1, nextRunAt: 1, createdAt: 1 },
      { name: 'idx_bg_jobs_status_next_created' },
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
  await ensureExecutionJobIndexes(db);
  indexesEnsured = true;
}

export async function updateJobProgress(
  db: Db,
  jobId: string | undefined,
  progress: Record<string, unknown>,
): Promise<void> {
  if (!jobId) return;
  await db.collection('bg_jobs').updateOne(
    { id: jobId },
    { $set: { progress, updatedAt: new Date() } },
  );
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
  const tid = normalizeTenantId(tenantId || 'default');

  if (shouldUseExecutionEnqueue(type)) {
    const mergedPayload = {
      ...payload,
      ...(grnId ? { grnId } : {}),
    };
    const input = mapLegacyEnqueueInput({
      type,
      tenantId: tid,
      payload: mergedPayload,
    });
    const dedupeKey = payload.dedupeKey != null ? String(payload.dedupeKey) : undefined;
    if (dedupeKey) input.dedupeKey = dedupeKey;
    return executionEnqueue(db, input);
  }

  await ensureBgJobIndexes(db);
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
  // SANDBOX_RESET: jangan reuse generik by type+tenant — profil/payload bisa beda
  // (KA vs full). Tanpa dedupeKey selalu buat job baru.
  if (
    !existing
    && !grnId
    && !dedupeKey
    && type !== JOB_TYPES.GRN_INVOICE_SYNC
    && type !== JOB_TYPES.GOODS_RETURN_CN_SYNC
    && type !== JOB_TYPES.SANDBOX_RESET
  ) {
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
    nextRunAt: null,
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

/** P0/H1.1: GRN_INVOICE_SYNC = recovery drain outbox (+ pull-reconcile). No soft-async PENDING happy path. */

export async function runGrnInvoiceSyncJob(db: Db, job: BgJob) {
  const grn = await db.collection('goods_receipts').findOne({ id: job.grnId }) as GrnDoc | null;
  if (!grn) return { error: 'GRN tidak ditemukan' };
  if (grn.status !== 'POSTED') return { error: 'GRN belum POSTED' };

  // Heal: hutang sudah ada (webhook sempat jalan / sync lain) tapi status GRN masih PENDING.
  if (grn.noDO && !grn.noInvoice) {
    const hutangFilter: Record<string, unknown> = {
      tenantId: grn.tenantId,
      noDO: grn.noDO,
    };
    if (grn.vendorTenantId) hutangFilter.vendorTenantId = grn.vendorTenantId;
    const existingHutang = await db.collection('hutang').findOne(hutangFilter) as {
      id?: string;
      noInvoice?: string;
      vendorInvoiceId?: string;
    } | null;
    if (existingHutang?.noInvoice) {
      await setGrnInvoiceSync(db, grn.id, {
        invoiceSyncStatus: 'DONE',
        invoiceSyncError: null,
        noInvoice: existingHutang.noInvoice,
        hutangId: existingHutang.id || null,
        vendorInvoiceId: existingHutang.vendorInvoiceId || null,
        invoiceSyncAt: new Date(),
      });
      const { getEnsureGrnInvoiceOutbox, markOutboxDone: mark } = await import('@/lib/api/integration-outbox');
      const row = await getEnsureGrnInvoiceOutbox(db, String(job.grnId));
      if (row) await mark(db, row.id);
      return { ok: true, healed: true, noInvoice: existingHutang.noInvoice };
    }
  }

  // Permanent path (no job poll): pull POSTED invoice from Sales by noDO → hutang → DONE.
  if (grn.noDO && !grn.noInvoice) {
    const { reconcileGrnInvoiceFromSales } = await import('@/lib/api/grn-invoice-reconcile');
    const pulled = await reconcileGrnInvoiceFromSales(db, grn);
    if (pulled.ok) {
      await setGrnInvoiceSync(db, grn.id, {
        invoiceSyncStatus: 'DONE',
        invoiceSyncError: null,
        noInvoice: pulled.noInvoice,
        hutangId: pulled.hutangId || null,
        vendorInvoiceId: pulled.invoiceId || null,
        invoiceSyncAt: new Date(),
      });
      const { getEnsureGrnInvoiceOutbox, markOutboxDone: mark } = await import('@/lib/api/integration-outbox');
      const row = await getEnsureGrnInvoiceOutbox(db, String(job.grnId));
      if (row) await mark(db, row.id);
      return { ok: true, reconciled: true, noInvoice: pulled.noInvoice, source: pulled.source };
    }
  }

  // H1.1 primary recovery: claim + drain business outbox (CreateInvoice via IntegrationClient).
  const drained = await drainEnsureGrnInvoice(db, {
    tenantId: job.tenantId,
    grnId: String(job.grnId),
    preferSync: true,
  });
  const result = drained.invoiceSync;
  if (drained.alreadyDone || result.status === 'DONE' || result.status === 'SKIPPED') {
    return { ok: true, result, outboxId: drained.outboxId, drained: true };
  }
  if (result.error) {
    return { error: result.error, result, outboxId: drained.outboxId, drained: true };
  }
  return { ok: true, result, outboxId: drained.outboxId, drained: true };
}

export async function runGoodsReturnCnSyncJob(db: Db, job: BgJob) {
  const returnId = String(job.payload?.returnId || '').trim();
  if (!returnId) return { error: 'returnId wajib untuk GOODS_RETURN_CN_SYNC' };
  const { drainEnsureGoodsReturnCn } = await import('@/lib/api/integration-outbox');
  const drained = await drainEnsureGoodsReturnCn(db, {
    tenantId: job.tenantId,
    returnId,
  });
  const result = drained.cnSync;
  if (drained.alreadyDone || result.status === 'DONE' || result.status === 'SKIPPED') {
    return { ok: true, result, outboxId: drained.outboxId, drained: true };
  }
  if (result.error) {
    return { error: result.error, result, outboxId: drained.outboxId, drained: true };
  }
  return { ok: true, result, outboxId: drained.outboxId, drained: true };
}

async function runCatalogSyncJob(db: Db, job: BgJob) {
  return executeCatalogSyncJob(db, job.tenantId, job.id);
}

async function runHutangSyncJob(db: Db, job: BgJob) {
  return executeHutangSyncJob(db, job.tenantId, job.payload || {});
}

async function runPoVendorSyncJob(db: Db, job: BgJob) {
  return executePoVendorSyncJob(db, job.tenantId, job.payload || {});
}

async function runWebhookInboxJob(db: Db, job: BgJob) {
  return executeWebhookInboxJob(db, job.payload || {});
}

export async function getJobById(db: Db, jobId: string, tenantId?: string | null) {
  const filter: Record<string, unknown> = { id: jobId };
  if (tenantId) filter.tenantId = normalizeTenantId(tenantId);
  return db.collection('bg_jobs').findOne(filter);
}

/** Baca job untuk UI — MASTER boleh lihat job `system` / lintas tenant. */
export async function getJobByIdAccessible(
  db: Db,
  jobId: string,
  auth: { isMaster?: boolean; role?: string; tenantId?: string | null } | null | undefined,
  scopeTenantId?: string | null,
) {
  const job = await db.collection('bg_jobs').findOne({ id: jobId });
  if (!job) return null;
  if (auth?.isMaster || auth?.role === 'MASTER') return job;
  const tid = normalizeTenantId(scopeTenantId || auth?.tenantId || 'default');
  return normalizeTenantId(String(job.tenantId)) === tid ? job : null;
}

export async function processJob(db: Db, job: BgJob) {
  if (!shouldUseLegacyBgPoll()) {
    return { skipped: true, reason: 'VPS menggunakan execution platform worker (EE-10)' };
  }

  if (isPlatformManagedJob(job)) {
    return { skipped: true, reason: 'execution-platform job — use execution:worker' };
  }

  const now = new Date();
  // Klaim atomik — dua worker paralel tidak memproses job yang sama.
  const claimed = await db.collection('bg_jobs').findOneAndUpdate(
    { id: job.id, status: 'PENDING' },
    {
      $set: { status: 'RUNNING', startedAt: now, updatedAt: now },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!claimed) return { skipped: true, reason: 'job sudah diproses worker lain' };
  const attempts = Number(claimed.attempts || 1);

  let outcome: Record<string, unknown>;
  try {
    if (job.type === JOB_TYPES.GRN_INVOICE_SYNC) {
      outcome = await runGrnInvoiceSyncJob(db, job);
    } else if (job.type === JOB_TYPES.GOODS_RETURN_CN_SYNC) {
      outcome = await runGoodsReturnCnSyncJob(db, job);
    } else if (job.type === JOB_TYPES.CATALOG_SYNC) {
      outcome = await runCatalogSyncJob(db, job);
    } else if (job.type === JOB_TYPES.HUTANG_SYNC) {
      outcome = await runHutangSyncJob(db, job);
    } else if (job.type === JOB_TYPES.PO_VENDOR_SYNC) {
      outcome = await runPoVendorSyncJob(db, job);
    } else if (job.type === JOB_TYPES.CANCEL_SO_PUSH_RECOVERY) {
      outcome = await executeCancelSoPushRecoveryJob(
        db,
        job.tenantId,
        (job.payload || {}) as Record<string, unknown>,
      );
    } else if (job.type === JOB_TYPES.WEBHOOK_INBOX) {
      outcome = await runWebhookInboxJob(db, job);
    } else if (job.type === JOB_TYPES.GRN_SYNC_SHIPPED) {
      outcome = await runGrnSyncShipped(db, job.tenantId);
    } else if (job.type === JOB_TYPES.GRN_POST_SIDE_EFFECTS) {
      outcome = await runGrnPostSideEffects(db, job.tenantId, String(job.grnId || job.payload?.grnId || ''));
    } else if (job.type === JOB_TYPES.GRN_RESOLVE_PRODUCTS) {
      const { runGrnResolveProducts } = await import('@/lib/api/grn-resolve-products-run');
      outcome = await runGrnResolveProducts(db, job.tenantId);
    } else if (job.type === JOB_TYPES.HUTANG_REPAIR) {
      const { runHutangRepairJob } = await import('@/lib/api/hutang-repair-run');
      outcome = await runHutangRepairJob(db, job);
    } else if (job.type === JOB_TYPES.HUTANG_BACKFILL) {
      const { backfillLegacyVendorInvoices } = await import('@/lib/api/migrate-hutang-approval');
      const { backfillHutangVarianceFields } = await import('@/lib/api/hutang-variance-enrich');
      const legacy = await backfillLegacyVendorInvoices(db, job.tenantId);
      const variance = await backfillHutangVarianceFields(db, job.tenantId);
      outcome = { legacy, variance };
    } else if (job.type === JOB_TYPES.INTEGRATION_RECONCILE) {
      const { runIntegrationReconcile } = await import('@/lib/api/integration-reconcile-run');
      const allTenants = job.payload?.allTenants === true;
      if (allTenants) {
        const tenants = await db.collection('tenants').find({}).project({ id: 1 }).toArray();
        const results: Record<string, unknown>[] = [];
        for (const t of tenants) {
          results.push({ ...(await runIntegrationReconcile(db, String(t.id))) });
        }
        outcome = { tenants: results.length, results };
      } else {
        outcome = { ...(await runIntegrationReconcile(db, job.tenantId)) };
      }
    } else if (job.type === JOB_TYPES.SANDBOX_RESET) {
      const { runSandboxResetJob } = await import('@/lib/api/sandbox-purge');
      outcome = await runSandboxResetJob(db, {
        tenantId: job.payload?.tenantId ? String(job.payload.tenantId) : undefined,
        includeSales: job.payload?.includeSales !== false,
        preserveJobId: job.id,
        profile: job.payload?.profile ? String(job.payload.profile) : undefined,
      });
    } else if (job.type === JOB_TYPES.AUDIT_LOG_PURGE) {
      const { runAuditLogPurgeJob } = await import('@/lib/api/audit-purge-run');
      outcome = await runAuditLogPurgeJob(db);
    } else {
      outcome = { error: `Unknown job type: ${job.type}` };
    }
  } catch (e) {
    outcome = { error: e instanceof Error ? e.message : String(e) };
  }

  const failed = 'error' in outcome && outcome.error;
  const done = new Date();
  if (!failed) {
    await db.collection('bg_jobs').updateOne(
      { id: job.id },
      {
        $set: {
          status: 'DONE',
          lastError: null,
          result: outcome,
          nextRunAt: null,
          finishedAt: done,
          updatedAt: done,
        },
      },
    );
  } else if (attempts >= MAX_ATTEMPTS) {
    // Dead-letter: gagal 3x — berhenti retry, tersimpan untuk inspeksi manual.
    await db.collection('bg_jobs').updateOne(
      { id: job.id },
      {
        $set: {
          status: 'FAILED',
          deadLetter: true,
          lastError: outcome.error,
          result: outcome,
          nextRunAt: null,
          finishedAt: done,
          updatedAt: done,
        },
      },
    );
  } else {
    // Retry otomatis dengan backoff eksponensial.
    await db.collection('bg_jobs').updateOne(
      { id: job.id },
      {
        $set: {
          status: 'PENDING',
          lastError: outcome.error,
          result: outcome,
          nextRunAt: new Date(Date.now() + retryDelayMs(attempts)),
          updatedAt: done,
        },
      },
    );
  }

  return outcome;
}

/** Reset job RUNNING yang menggantung (worker mati di tengah proses). */
export async function recoverStaleRunningJobs(
  db: Db,
  { maxAgeMs = STALE_RUNNING_MS } = {},
): Promise<number> {
  if (!shouldUseLegacyBgPoll()) return 0;

  const cutoff = new Date(Date.now() - maxAgeMs);
  const res = await db.collection('bg_jobs').updateMany(
    {
      status: 'RUNNING',
      jobSchemaVersion: { $exists: false },
      $or: [
        { updatedAt: { $lt: cutoff } },
        { startedAt: { $lt: cutoff } },
      ],
    },
    {
      $set: {
        status: 'PENDING',
        nextRunAt: new Date(),
        updatedAt: new Date(),
        lastError: 'Recovered from stale RUNNING (worker timeout)',
      },
    },
  );
  return res.modifiedCount;
}

/** Re-queue dead-letter jobs untuk retry setelah perbaikan integrasi. */
export async function requeueDeadLetterJobs(
  db: Db,
  {
    types = null,
    tenantId = null,
    lastErrorIncludes = null,
  }: {
    types?: string[] | null;
    tenantId?: string | null;
    lastErrorIncludes?: string | null;
  } = {},
): Promise<number> {
  const filter: Record<string, unknown> = { status: 'FAILED', deadLetter: true };
  if (types?.length) filter.type = { $in: types };
  if (tenantId) filter.tenantId = normalizeTenantId(tenantId);
  if (lastErrorIncludes) {
    filter.lastError = { $regex: lastErrorIncludes, $options: 'i' };
  }

  const res = await db.collection('bg_jobs').updateMany(filter, {
    $set: {
      status: 'PENDING',
      deadLetter: false,
      attempts: 0,
      nextRunAt: new Date(),
      updatedAt: new Date(),
      startedAt: null,
      finishedAt: null,
    },
  });
  return res.modifiedCount;
}

/** Jalankan satu job segera — serverless / legacy poll only (EE-10). */
export async function processJobById(db: Db, jobId: string) {
  if (!shouldUseLegacyBgPoll()) {
    return { skipped: true, reason: 'VPS menggunakan execution platform worker (EE-10)' };
  }

  const row = await db.collection('bg_jobs').findOne({ id: jobId });
  if (!row || row.status !== 'PENDING') return null;
  const job = row as unknown as BgJob;
  if ((job.attempts || 0) >= MAX_ATTEMPTS) return null;
  return processJob(db, job);
}

export async function processPendingJobs(
  db: Db,
  { limit = 5, types = null }: { limit?: number; types?: string[] | null } = {},
) {
  if (!shouldUseLegacyBgPoll()) {
    return [{ skipped: true, reason: 'VPS menggunakan execution platform worker (EE-10)' }];
  }

  await ensureBgJobIndexes(db);
  const recovered = await recoverStaleRunningJobs(db);

  const filter: Record<string, unknown> = {
    status: 'PENDING',
    jobSchemaVersion: { $exists: false },
    $or: [
      { nextRunAt: null },
      { nextRunAt: { $exists: false } },
      { nextRunAt: { $lte: new Date() } },
    ],
  };
  if (types?.length) filter.type = { $in: types };

  const jobs = await db.collection('bg_jobs')
    .find(filter)
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();

  // Prioritas: invoice GRN lebih dulu (user menunggu di halaman Penerimaan).
  jobs.sort((a, b) => {
    const aInv = a.type === JOB_TYPES.GRN_INVOICE_SYNC ? 0 : 1;
    const bInv = b.type === JOB_TYPES.GRN_INVOICE_SYNC ? 0 : 1;
    if (aInv !== bInv) return aInv - bInv;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  const results: Record<string, unknown>[] = [];
  if (recovered > 0) {
    results.push({ recoveredStaleRunning: recovered });
  }
  for (const jobRow of jobs) {
    const job = jobRow as unknown as BgJob;
    results.push({ jobId: job.id, ...(await processJob(db, job)) });
  }
  return results;
}

/**
 * Wake / drain workers after enqueue.
 * VPS/job-bus: in-process processOneTick (cepat) + Redis wake dari enqueue.
 * Legacy: in-process poll.
 */
export function scheduleJobProcessing(db: Db, { limit = 3 }: { limit?: number } = {}) {
  if (!shouldUseLegacyBgPoll()) {
    void import('@/lib/api/process-execution-jobs').then(({ processExecutionJobs }) =>
      processExecutionJobs(db, {
        limit: Math.min(8, Math.max(2, limit)),
        domain: 'inventory',
        workerId: 'schedule-kick',
        capabilities: ['SYNC', 'CPU_BATCH', 'WEBHOOK'],
        // Recovery berat dijalankan oleh inventory-worker + safety-net /api/bg-jobs/process.
        skipRecovery: true,
      }),
    ).catch((e: unknown) => {
      console.warn('[bg-jobs] execution drain error:', e instanceof Error ? e.message : e);
    });
    return;
  }

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
