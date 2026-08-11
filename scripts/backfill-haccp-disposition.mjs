#!/usr/bin/env node
/**
 * ADR-004 P0B — materialkan disposition pada haccp_results lama.
 *
 * Baca aplikasi sudah aman tanpa skrip ini (effectiveHaccpDisposition), jadi
 * backfill murni agar filter/index disposition dapat dipakai.
 *
 * Aturan turunan (sama dengan effectiveHaccpDisposition):
 *   requiredFailCount > 0 → FAIL
 *   status = COMPLETED    → PASS
 *   selain itu            → PENDING
 *
 * Dry-run adalah default. Tambahkan --apply untuk menulis.
 *
 *   node scripts/backfill-haccp-disposition.mjs
 *   node scripts/backfill-haccp-disposition.mjs --tenant=t1 --apply
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

const VALID = ['PENDING', 'PASS', 'FAIL'];
const COLLECTION = 'haccp_results';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const tenantArg = args.find((a) => a.startsWith('--tenant='));
const tenantId = tenantArg ? tenantArg.slice('--tenant='.length).trim() : '';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/inventory';

function deriveDisposition(doc) {
  if (Number(doc?.summary?.requiredFailCount || 0) > 0) return 'FAIL';
  if (doc?.status === 'COMPLETED') return 'PASS';
  return 'PENDING';
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const col = db.collection(COLLECTION);

  const scope = tenantId ? { tenantId } : {};
  const total = await col.countDocuments(scope);
  const missing = await col.countDocuments({ ...scope, disposition: { $exists: false } });
  const invalid = await col
    .find({ ...scope, disposition: { $exists: true, $nin: VALID } })
    .project({ id: 1, tenantId: 1, noDokumen: 1, disposition: 1 })
    .limit(50)
    .toArray();

  const byStatus = await col.aggregate([
    { $match: scope },
    { $group: { _id: '$disposition', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]).toArray();

  console.log('--- ADR-004 backfill haccp disposition ---');
  console.log('mode     :', apply ? 'APPLY' : 'DRY-RUN (tambahkan --apply untuk menulis)');
  console.log('tenant   :', tenantId || '(semua)');
  console.log('total    :', total);
  console.log('tanpa fld:', missing);
  console.log('distribusi:', byStatus.map((r) => `${r._id ?? '(kosong)'}=${r.n}`).join(' ') || '-');

  if (invalid.length) {
    console.warn(`\n! ${invalid.length}+ dokumen punya disposition di luar ${VALID.join('|')}:`);
    for (const d of invalid) {
      console.warn(`  ${d.tenantId}/${d.noDokumen || d.id} → ${JSON.stringify(d.disposition)}`);
    }
    console.warn('  Nilai ini tidak diubah otomatis; periksa manual sebelum lanjut.');
  }

  if (!missing) {
    console.log('\nTidak ada yang perlu di-backfill.');
    await client.close();
    return;
  }

  const sample = await col
    .find({ ...scope, disposition: { $exists: false } })
    .project({ id: 1, tenantId: 1, noDokumen: 1, status: 1, summary: 1 })
    .limit(5)
    .toArray();
  console.log('\ncontoh turunan:');
  for (const d of sample) {
    console.log(`  ${d.tenantId}/${d.noDokumen || d.id} status=${d.status} → ${deriveDisposition(d)}`);
  }

  if (!apply) {
    console.log(`\nDRY-RUN: ${missing} dokumen akan di-set disposition dari status/summary.`);
    await client.close();
    return;
  }

  let modified = 0;
  const cursor = col.find({ ...scope, disposition: { $exists: false } });
  for await (const doc of cursor) {
    const disposition = deriveDisposition(doc);
    const res = await col.updateOne(
      { _id: doc._id, disposition: { $exists: false } },
      { $set: { disposition } },
    );
    if (res.modifiedCount) modified += 1;
  }

  console.log(`\nAPPLY: modified=${modified}`);
  const left = await col.countDocuments({ ...scope, disposition: { $exists: false } });
  console.log('sisa tanpa field:', left);
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
