#!/usr/bin/env node
/**
 * Diagnosa antrian bg_jobs yang membuat banner "Worker background tertunda".
 *
 * Usage:
 *   MONGO_URL=... DB_NAME=inventory_customer npm run diag:bg-jobs
 *   npm run diag:bg-jobs -- --json
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';

function loadEnvLocal() {
  for (const name of ['.env.local', '.env', '.env.docker']) {
    const p = resolve(process.cwd(), name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key]) continue;
      process.env[key] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnvLocal();

const OPEN = ['PENDING', 'DISPATCHED', 'RETRYING'];
const asJson = process.argv.includes('--json');

async function main() {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || 'inventory_customer';
  if (!uri) {
    console.error('MONGO_URL / MONGODB_URI wajib');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const col = db.collection('bg_jobs');

  const open = await col
    .find(
      { status: { $in: OPEN } },
      {
        projection: {
          id: 1,
          type: 1,
          status: 1,
          domain: 1,
          jobSchemaVersion: 1,
          createdAt: 1,
          updatedAt: 1,
          nextRunAt: 1,
          lastError: 1,
          claimedBy: 1,
          visibilityTimeoutAt: 1,
          attempts: 1,
        },
      },
    )
    .sort({ createdAt: 1 })
    .limit(50)
    .toArray();

  const now = Date.now();
  const rows = open.map((j) => {
    const created = j.createdAt ? new Date(j.createdAt).getTime() : NaN;
    const ageMin = Number.isFinite(created) ? Math.floor((now - created) / 60_000) : null;
    const legacyOrphan = j.jobSchemaVersion == null;
    return {
      id: j.id || String(j._id),
      type: j.type,
      status: j.status,
      domain: j.domain ?? null,
      jobSchemaVersion: j.jobSchemaVersion ?? null,
      ageMin,
      legacyOrphan,
      nextRunAt: j.nextRunAt ?? null,
      lastError: j.lastError ?? null,
      claimedBy: j.claimedBy ?? null,
      visibilityTimeoutAt: j.visibilityTimeoutAt ?? null,
      attempts: j.attempts ?? 0,
    };
  });

  const orphanLegacy = rows.filter((r) => r.legacyOrphan).length;
  const dispatched = rows.filter((r) => r.status === 'DISPATCHED').length;
  const oldestAgeMin = rows[0]?.ageMin ?? null;

  const report = {
    dbName,
    openCount: rows.length,
    orphanLegacy,
    dispatched,
    oldestAgeMin,
    workerStale: oldestAgeMin != null && oldestAgeMin >= 5,
    jobs: rows,
    hints: [
      'VPS: docker ps | grep inventory-worker — harus Up/healthy',
      'Samakan WORKER_SECRET app ↔ worker',
      'Pulihkan: npm run execution:doctor -- --recovery  (atau POST /api/bg-jobs/process dengan X-Worker-Secret)',
      'Orphan legacy tanpa jobSchemaVersion: migrate:bg-jobs-v1 atau recovery normalizeLegacyJobs',
    ],
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`DB=${dbName} open=${report.openCount} orphanLegacy=${orphanLegacy} dispatched=${dispatched} oldestAgeMin=${oldestAgeMin}`);
    console.log(`workerStale=${report.workerStale}`);
    for (const j of rows.slice(0, 20)) {
      console.log(
        `  ${j.status.padEnd(10)} age=${String(j.ageMin).padStart(5)}m  type=${j.type}  domain=${j.domain}  schema=${j.jobSchemaVersion ?? 'LEGACY'}  id=${j.id}`,
      );
      if (j.lastError) console.log(`    err: ${String(j.lastError).slice(0, 120)}`);
    }
    console.log('\nHints:');
    for (const h of report.hints) console.log(`  - ${h}`);
  }

  await client.close();
  process.exit(report.workerStale ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
