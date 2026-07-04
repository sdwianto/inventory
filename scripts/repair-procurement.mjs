#!/usr/bin/env node
/**
 * Perbaikan data procurement — URL integrasi, job stuck/dead-letter, variance hutang.
 *
 * Usage:
 *   SALES_APP_URL=https://sales-dawam.vercel.app node scripts/repair-procurement.mjs --apply
 *   node scripts/repair-procurement.mjs            # dry-run
 *   node scripts/repair-procurement.mjs --apply --tenant=sppg --process-jobs
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';

function loadEnv() {
  try {
    const p = resolve(process.cwd(), '.env.local');
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* ignore */ }
}
loadEnv();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PROCESS_JOBS = args.includes('--process-jobs');
const tenantArg = args.find((a) => a.startsWith('--tenant='));
const TENANT = tenantArg ? tenantArg.split('=')[1] : 'sppg';
const SALES_URL = (process.env.SALES_APP_URL || 'https://sales-dawam.vercel.app').replace(/\/$/, '');
const INVENTORY_URL = (process.env.INVENTORY_APP_URL || 'https://penarukan2.vercel.app').replace(/\/$/, '');
const STALE_MS = 15 * 60 * 1000;

const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'inventory_customer';

if (!uri) {
  console.error('MONGO_URL / MONGODB_URI tidak ada');
  process.exit(1);
}

function isLoopback(url) {
  return /localhost|127\.0\.0\.1/i.test(String(url || ''));
}

async function patchUrls(db, dryRun) {
  const linkFilter = {
    customerTenantId: TENANT,
    salesAppUrl: { $regex: 'localhost|127\\.0\\.0\\.1', $options: 'i' },
  };
  const linkCount = await db.collection('integration_links').countDocuments(linkFilter);
  const settingsFilter = {
    tenantId: TENANT,
    salesAppUrl: { $regex: 'localhost|127\\.0\\.0\\.1', $options: 'i' },
  };
  const settingsCount = await db.collection('integration_settings').countDocuments(settingsFilter);

  console.log(`\n[URLs] integration_links localhost → ${SALES_URL}: ${linkCount}`);
  console.log(`[URLs] integration_settings localhost → ${SALES_URL}: ${settingsCount}`);

  if (!dryRun && (linkCount || settingsCount)) {
    if (linkCount) {
      await db.collection('integration_links').updateMany(linkFilter, {
        $set: { salesAppUrl: SALES_URL, updatedAt: new Date() },
      });
    }
    if (settingsCount) {
      await db.collection('integration_settings').updateMany(settingsFilter, {
        $set: { salesAppUrl: SALES_URL, updatedAt: new Date() },
      });
    }
  }
  return linkCount + settingsCount;
}

async function recoverStaleRunning(db, dryRun) {
  const cutoff = new Date(Date.now() - STALE_MS);
  const filter = {
    status: 'RUNNING',
    $or: [{ updatedAt: { $lt: cutoff } }, { startedAt: { $lt: cutoff } }],
  };
  const stuck = await db.collection('bg_jobs').find(filter).project({
    id: 1, type: 1, tenantId: 1, grnId: 1, startedAt: 1,
  }).toArray();
  console.log(`\n[Jobs] stale RUNNING → PENDING: ${stuck.length}`);
  for (const j of stuck) {
    console.log(`  - ${j.type} tenant=${j.tenantId} grn=${j.grnId || '-'} since ${j.startedAt}`);
  }
  if (!dryRun && stuck.length) {
    await db.collection('bg_jobs').updateMany(filter, {
      $set: {
        status: 'PENDING',
        nextRunAt: new Date(),
        updatedAt: new Date(),
        lastError: 'Recovered from stale RUNNING (repair-procurement)',
      },
    });
  }
  return stuck.length;
}

async function requeueDeadLetters(db, dryRun) {
  const filter = { status: 'FAILED', deadLetter: true };
  const dead = await db.collection('bg_jobs').find(filter).project({
    id: 1, type: 1, tenantId: 1, lastError: 1, grnId: 1,
  }).toArray();
  console.log(`\n[Jobs] dead-letter → PENDING retry: ${dead.length}`);
  for (const j of dead) {
    const err = String(j.lastError || '').slice(0, 120);
    console.log(`  - ${j.type} tenant=${j.tenantId} grn=${j.grnId || '-'} | ${err}`);
  }
  if (!dryRun && dead.length) {
    await db.collection('bg_jobs').updateMany(filter, {
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
  }
  return dead.length;
}

async function backfillVariance(db, dryRun) {
  const count = await db.collection('hutang').countDocuments({
    tenantId: TENANT,
    referenceType: 'VENDOR_INVOICE',
  });
  console.log(`\n[Variance] ${count} hutang vendor — backfill otomatis saat buka Pengeluaran Pengadaan / GET procurement-expenses`);
  if (dryRun) return 0;
  // Tidak import TS di CLI — variance dihitung live oleh resolveHutangVariance di API.
  return 0;
}

async function reconcileGrn(db, dryRun) {
  const grnCutoff = new Date(Date.now() - 60 * 60 * 1000);
  const grnSyncingCutoff = new Date(Date.now() - 5 * 60 * 1000);
  const grns = await db.collection('goods_receipts').find({
    tenantId: TENANT,
    status: 'POSTED',
    $or: [
      { invoiceSyncStatus: 'SYNCING', postedAt: { $lt: grnSyncingCutoff } },
      { invoiceSyncStatus: { $in: ['PENDING', 'FAILED'] }, postedAt: { $lt: grnCutoff } },
    ],
  }).project({ id: 1, noGRN: 1, invoiceSyncStatus: 1 }).toArray();

  console.log(`\n[Reconcile] GRN invoice stale: ${grns.length}`);
  for (const g of grns) {
    console.log(`  - ${g.noGRN || g.id} status=${g.invoiceSyncStatus}`);
  }
  if (dryRun || !grns.length) return 0;

  let queued = 0;
  const now = new Date();
  for (const grn of grns) {
    const existing = await db.collection('bg_jobs').findOne({
      type: 'GRN_INVOICE_SYNC',
      grnId: grn.id,
      status: { $in: ['PENDING', 'RUNNING'] },
    });
    if (existing) continue;
    await db.collection('bg_jobs').insertOne({
      id: randomUUID(),
      type: 'GRN_INVOICE_SYNC',
      tenantId: TENANT,
      grnId: grn.id,
      payload: { dedupeKey: `reconcile-grn:${grn.id}` },
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      nextRunAt: null,
    });
    queued += 1;
  }
  console.log(`  → enqueued ${queued} GRN_INVOICE_SYNC job(s)`);
  return queued;
}

async function triggerWorker() {
  const secret = process.env.WORKER_SECRET || process.env.CRON_SECRET;
  if (!secret) {
    console.log('\n[Worker] skip — WORKER_SECRET tidak ada (set di .env.local atau Vercel)');
    return;
  }
  const res = await fetch(`${INVENTORY_URL}/api/bg-jobs/process`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`\n[Worker] POST ${INVENTORY_URL}/api/bg-jobs/process → HTTP ${res.status}`);
  console.log(`  processed: ${body.processed ?? '?'}, recovered: ${body.recoveredStaleRunning ?? '?'}`);
}

async function main() {
  console.log(`\n=== repair-procurement ${APPLY ? 'APPLY' : 'DRY-RUN'} ===`);
  console.log({ tenant: TENANT, salesUrl: SALES_URL, inventoryUrl: INVENTORY_URL, dbName });

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  try {
    const urlPatched = await patchUrls(db, !APPLY);
    const recovered = await recoverStaleRunning(db, !APPLY);
    const requeued = await requeueDeadLetters(db, !APPLY);

    let varianceUpdated = 0;
    let grnQueued = 0;
    if (APPLY) {
      varianceUpdated = await backfillVariance(db, false);
      grnQueued = await reconcileGrn(db, false);
    } else {
      await backfillVariance(db, true);
      await reconcileGrn(db, true);
    }

    const healthRes = await fetch(`${INVENTORY_URL}/api/health`, { signal: AbortSignal.timeout(15000) });
    const health = await healthRes.json().catch(() => ({}));
    console.log(`\n[Health] inventory deadLetter=${health?.checks?.worker?.deadLetterCount ?? '?'}`);

    if (APPLY && PROCESS_JOBS) {
      await triggerWorker();
    }

    console.log('\n=== Summary ===');
    console.log({
      urlPatched,
      recovered,
      requeued,
      varianceUpdated,
      grnQueued,
      mode: APPLY ? 'applied' : 'dry-run',
    });
    if (!APPLY) {
      console.log('\nJalankan dengan --apply untuk menerapkan perbaikan.');
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
