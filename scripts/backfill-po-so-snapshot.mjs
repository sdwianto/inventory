/**
 * Backfill vendorSoSnapshot pada PO dari vendorSubmissions + perbaiki variance hutang.
 * Jalankan: node scripts/backfill-po-so-snapshot.mjs [--apply]
 */
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildVendorSoSnapshot, mergeVendorSoSnapshots } from '../lib/api/vendor-so-snapshot.js';
import { backfillHutangVarianceFields } from '../lib/api/hutang-variance-enrich.js';

function loadEnv() {
  try {
    const p = resolve(process.cwd(), '.env.local');
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
}
loadEnv();

const apply = process.argv.includes('--apply');
const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017');
await client.connect();
const db = client.db(process.env.DB_NAME || 'inventory_customer');

const pos = await db.collection('customer_purchase_orders')
  .find({ vendorSubmissions: { $exists: true, $ne: [] } })
  .toArray();

let poUpdated = 0;
for (const po of pos) {
  const snaps = (po.vendorSubmissions || []).map((sub) => {
    if (!sub?.vendorSo) return null;
    return buildVendorSoSnapshot({
      ...sub.vendorSo,
      salesOrderId: sub.vendorSoId || sub.vendorSo.id,
      noSO: sub.vendorNoSO || sub.vendorSo.noSO,
    });
  }).filter(Boolean);

  const merged = mergeVendorSoSnapshots(snaps);
  if (!merged) continue;

  const oldTotal = parseInt(po.vendorSoSnapshot?.total || 0, 10);
  if (oldTotal === merged.total) continue;

  console.log(`${po.noPO}: SO snapshot ${oldTotal} → ${merged.total}${apply ? ' (apply)' : ''}`);
  if (apply) {
    await db.collection('customer_purchase_orders').updateOne(
      { id: po.id },
      { $set: { vendorSoSnapshot: merged, updatedAt: new Date() } },
    );
    poUpdated += 1;
  }
}

if (apply) {
  const hutang = await backfillHutangVarianceFields(db, null);
  console.log('PO updated:', poUpdated, '| Hutang variance updated:', hutang.updated);
} else {
  console.log('Dry run — tambahkan --apply untuk menulis ke DB');
}

await client.close();
