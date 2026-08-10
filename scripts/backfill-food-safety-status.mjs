#!/usr/bin/env node
/**
 * ADR-004 P0A — materialkan foodSafetyStatus = PENDING pada production_batches lama.
 *
 * Baca aplikasi sudah aman tanpa skrip ini (baris tanpa field dibaca sebagai
 * PENDING), jadi backfill murni untuk membuat filter dan index dapat dipakai.
 *
 * Dry-run adalah default. Tambahkan --apply untuk menulis.
 *
 *   node scripts/backfill-food-safety-status.mjs
 *   node scripts/backfill-food-safety-status.mjs --tenant=t1 --apply
 */

import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv() {
  try {
    for (const name of ['.env.local', '.env']) {
      const p = resolve(process.cwd(), name);
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m && !process.env[m[1].trim()]) {
          process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch { /* ignore */ }
}
loadEnv();

const VALID = ['PENDING', 'PASS', 'HOLD', 'RELEASED'];
const COLLECTION = 'production_batches';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const tenantArg = args.find((a) => a.startsWith('--tenant='));
const tenantId = tenantArg ? tenantArg.slice('--tenant='.length).trim() : '';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/inventory';

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const col = db.collection(COLLECTION);

  const scope = tenantId ? { tenantId } : {};

  const total = await col.countDocuments(scope);
  const missing = await col.countDocuments({ ...scope, foodSafetyStatus: { $exists: false } });
  const invalid = await col
    .find({ ...scope, foodSafetyStatus: { $exists: true, $nin: VALID } })
    .project({ id: 1, tenantId: 1, batchNo: 1, foodSafetyStatus: 1 })
    .limit(50)
    .toArray();

  const byStatus = await col.aggregate([
    { $match: scope },
    { $group: { _id: '$foodSafetyStatus', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]).toArray();

  console.log('--- ADR-004 backfill foodSafetyStatus ---');
  console.log('mode     :', apply ? 'APPLY' : 'DRY-RUN (tambahkan --apply untuk menulis)');
  console.log('tenant   :', tenantId || '(semua)');
  console.log('total    :', total);
  console.log('tanpa fld:', missing);
  console.log('distribusi:', byStatus.map((r) => `${r._id ?? '(kosong)'}=${r.n}`).join(' ') || '-');

  if (invalid.length) {
    console.warn(`\n! ${invalid.length}+ batch punya foodSafetyStatus di luar ${VALID.join('|')}:`);
    for (const b of invalid) {
      console.warn(`  ${b.tenantId}/${b.batchNo || b.id} → ${JSON.stringify(b.foodSafetyStatus)}`);
    }
    console.warn('  Nilai ini tidak diubah otomatis; periksa manual sebelum lanjut.');
  }

  if (!missing) {
    console.log('\nTidak ada yang perlu di-backfill.');
    await client.close();
    return;
  }

  if (!apply) {
    console.log(`\nDRY-RUN: ${missing} batch akan di-set foodSafetyStatus = PENDING.`);
    await client.close();
    return;
  }

  const res = await col.updateMany(
    { ...scope, foodSafetyStatus: { $exists: false } },
    { $set: { foodSafetyStatus: 'PENDING' } },
  );
  console.log(`\nAPPLY: matched=${res.matchedCount} modified=${res.modifiedCount}`);

  const left = await col.countDocuments({ ...scope, foodSafetyStatus: { $exists: false } });
  console.log('sisa tanpa field:', left);
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
