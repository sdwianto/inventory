// Antrian job background — invoice GRN, dll. (MongoDB-backed).

import { v4 as uuidv4 } from 'uuid';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import { notifyGrnPostedToSales } from '@/lib/api/grn-notify-sales';

export const JOB_TYPES = {
  GRN_INVOICE_SYNC: 'GRN_INVOICE_SYNC',
};

const MAX_ATTEMPTS = 3;

let indexesEnsured = false;

export async function ensureBgJobIndexes(db) {
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
  } catch (e) {
    if (e?.code !== 85 && e?.code !== 86) console.warn('bg_jobs index:', e.message);
  }
  indexesEnsured = true;
}

export async function enqueueJob(db, { type, tenantId, grnId, payload = {} }) {
  await ensureBgJobIndexes(db);
  const tid = normalizeTenantId(tenantId || 'default');
  const now = new Date();

  const existing = grnId
    ? await db.collection('bg_jobs').findOne({
      type,
      grnId,
      status: { $in: ['PENDING', 'RUNNING'] },
    })
    : null;
  if (existing) return { jobId: existing.id, reused: true };

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

async function setGrnInvoiceSync(db, grnId, patch) {
  if (!grnId) return;
  await db.collection('goods_receipts').updateOne(
    { id: grnId },
    { $set: { ...patch, updatedAt: new Date() } },
  );
}

export async function runGrnInvoiceSyncJob(db, job) {
  const grn = await db.collection('goods_receipts').findOne({ id: job.grnId });
  if (!grn) return { error: 'GRN tidak ditemukan' };
  if (grn.status !== 'POSTED') return { error: 'GRN belum POSTED' };

  await setGrnInvoiceSync(db, grn.id, {
    invoiceSyncStatus: 'SYNCING',
    invoiceSyncError: null,
  });

  const result = await notifyGrnPostedToSales(db, job.tenantId, grn);

  if (result.error) {
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

  const patch = {
    invoiceSyncStatus: 'DONE',
    invoiceSyncError: null,
    invoiceSyncAt: new Date(),
  };
  if (result.noInvoice) patch.noInvoice = result.noInvoice;
  if (result.invoiceId) patch.vendorInvoiceId = result.invoiceId;
  await setGrnInvoiceSync(db, grn.id, patch);

  return { ok: true, result };
}

export async function processJob(db, job) {
  const now = new Date();
  await db.collection('bg_jobs').updateOne(
    { id: job.id },
    {
      $set: { status: 'RUNNING', startedAt: now, updatedAt: now },
      $inc: { attempts: 1 },
    },
  );

  let outcome;
  try {
    if (job.type === JOB_TYPES.GRN_INVOICE_SYNC) {
      outcome = await runGrnInvoiceSyncJob(db, job);
    } else {
      outcome = { error: `Unknown job type: ${job.type}` };
    }
  } catch (e) {
    outcome = { error: e?.message || String(e) };
  }

  const failed = !!outcome?.error;
  await db.collection('bg_jobs').updateOne(
    { id: job.id },
    {
      $set: {
        status: failed ? 'FAILED' : 'DONE',
        lastError: failed ? outcome.error : null,
        result: outcome,
        finishedAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );

  return outcome;
}

export async function processPendingJobs(db, { limit = 5, types = null } = {}) {
  await ensureBgJobIndexes(db);
  const filter = { status: 'PENDING' };
  if (types?.length) filter.type = { $in: types };

  const jobs = await db.collection('bg_jobs')
    .find(filter)
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();

  const results = [];
  for (const job of jobs) {
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
export function scheduleJobProcessing(db, { limit = 3 } = {}) {
  setImmediate(() => {
    processPendingJobs(db, { limit }).catch((e) => {
      console.warn('[bg-jobs] process error:', e?.message || e);
    });
  });
}

export async function getJobStatusForGrn(db, grnId) {
  const job = await db.collection('bg_jobs')
    .find({ grnId, type: JOB_TYPES.GRN_INVOICE_SYNC })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  return job || null;
}
