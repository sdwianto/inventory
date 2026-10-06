/**
 * Pindahkan job Inventory yang terlanjur ber-domain `sales` (tidak pernah diklaim inventory-worker)
 * ke domain `inventory`. Penyebab: tipe di luar kontrak bersama di-default ke `sales` oleh
 * mapLegacyEnqueueInput / normalizeLegacyJobs.
 * Jalankan: node scripts/repair-bg-jobs-domain.mjs [--apply]
 */
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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

/** Harus sinkron dengan JOB_TYPES di lib/api/bg-jobs.ts. */
const INVENTORY_JOB_TYPES = [
  'GRN_INVOICE_SYNC', 'GOODS_RETURN_CN_SYNC', 'CATALOG_SYNC', 'HUTANG_SYNC', 'PO_VENDOR_SYNC',
  'CANCEL_SO_PUSH_RECOVERY', 'WEBHOOK_INBOX', 'GRN_SYNC_SHIPPED', 'GRN_POST_SIDE_EFFECTS',
  'GRN_RESOLVE_PRODUCTS', 'HUTANG_REPAIR', 'HUTANG_BACKFILL', 'INTEGRATION_RECONCILE',
  'INVENTORY_RECON', 'SANDBOX_RESET', 'AUDIT_LOG_PURGE', 'PRODUCT_ENRICHMENT_SYNC',
  'PO_VENDOR_AVAILABILITY_REFRESH', 'PO_ARRIVAL_RISK_ALERT', 'NOTIFICATION_OUTBOX_DRAIN',
  'CUSTOMER_TAX_PROFILE_PUSH',
];
const OPEN_STATUSES = ['PENDING', 'DISPATCHED', 'RETRYING'];

const apply = process.argv.includes('--apply');
const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017');
await client.connect();
const db = client.db(process.env.DB_NAME || 'inventory_customer');
const jobs = db.collection('bg_jobs');

const filter = {
  domain: { $ne: 'inventory' },
  type: { $in: INVENTORY_JOB_TYPES },
  status: { $in: OPEN_STATUSES },
};

const stuck = await jobs
  .find(filter, { projection: { _id: 0, id: 1, type: 1, tenantId: 1, status: 1, domain: 1, createdAt: 1 } })
  .sort({ createdAt: 1 })
  .toArray();

for (const j of stuck) {
  console.log(`${j.id} ${j.type} tenant=${j.tenantId} status=${j.status} domain=${j.domain ?? '-'} createdAt=${j.createdAt instanceof Date ? j.createdAt.toISOString() : j.createdAt}`);
}

if (apply && stuck.length) {
  const res = await jobs.updateMany(
    { ...filter, id: { $in: stuck.map((j) => j.id) } },
    { $set: { domain: 'inventory', updatedAt: new Date().toISOString() } },
  );
  console.log(`Dipindahkan ke domain inventory: ${res.modifiedCount}/${stuck.length}`);
} else {
  console.log(`Job macet: ${stuck.length}`);
  if (!apply) console.log('Dry run — tambahkan --apply untuk menulis ke DB');
}

await client.close();
