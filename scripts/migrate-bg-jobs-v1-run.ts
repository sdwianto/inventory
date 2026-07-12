#!/usr/bin/env node
/**
 * Migrasi bg_jobs legacy → platform v1 schema (§02).
 * Idempotent — aman dijalankan ulang.
 *
 * Usage: npm run migrate:bg-jobs-v1 [-- --dry-run] [-- --tenant=ID]
 * Env: MONGO_URL, DB_NAME (atau dari .env.local)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import {
  buildBgJobV1Patch,
  needsBgJobV1Migration,
} from '@/lib/execution/ops/migrate-bg-jobs-v1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const TENANT_ARG = process.argv.find((a) => a.startsWith('--tenant='));
const TENANT_FILTER = TENANT_ARG ? TENANT_ARG.split('=')[1]?.trim() : '';

const COLLECTION = 'bg_jobs';

function loadEnvLocal() {
  const p = resolve(root, '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

async function main() {
  loadEnvLocal();
  const mongoUrl = process.env.MONGO_URL?.trim();
  const dbName = process.env.DB_NAME?.trim();
  if (!mongoUrl || !dbName) {
    console.error('MONGO_URL and DB_NAME are required');
    process.exit(1);
  }

  const platformVersion = (
    process.env.EXECUTION_PLATFORM_VERSION
    ?? process.env.PLATFORM_VERSION
    ?? '1'
  ).trim();

  const client = new MongoClient(mongoUrl);
  await client.connect();
  const db = client.db(dbName);
  const collection = db.collection(COLLECTION);

  const filter = TENANT_FILTER ? { tenantId: TENANT_FILTER } : {};
  const cursor = collection.find(filter);
  let scanned = 0;
  let migrated = 0;
  const samples: Array<{ id: unknown; before: unknown; after: unknown }> = [];

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) continue;
    scanned += 1;
    const row = doc as Record<string, unknown>;
    if (!needsBgJobV1Migration(row)) continue;

    const update = buildBgJobV1Patch(row, platformVersion);
    migrated += 1;
    if (samples.length < 5) {
      samples.push({
        id: row.id,
        before: row.status,
        after: update.$set.status ?? row.status,
      });
    }

    if (!DRY_RUN) {
      await collection.updateOne({ _id: doc._id }, update);
    }
  }

  console.log('[migrate-bg-jobs-v1]', {
    dryRun: DRY_RUN,
    tenant: TENANT_FILTER || 'all',
    scanned,
    migrated,
    platformVersion,
    samples,
  });

  await client.close();
}

main().catch((e) => {
  console.error('[migrate-bg-jobs-v1] failed:', e);
  process.exit(1);
});
