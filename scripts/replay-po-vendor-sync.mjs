#!/usr/bin/env node
/**
 * Replay kirim PO APPROVED → sales.app (prod repair).
 *
 *   node scripts/replay-po-vendor-sync.mjs --noPO=CPO2607000006 --apply
 *   node scripts/replay-po-vendor-sync.mjs --all-pending --apply
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __dir = dirname(fileURLToPath(import.meta.url));
const prodEnv = join(__dir, '../../../sales/sales/.env.production.local');
const SALES_URL = 'https://sales-dawam.vercel.app';

function loadEnv() {
  if (!existsSync(prodEnv)) {
    console.error('Butuh sales/.env.production.local');
    process.exit(1);
  }
  for (const line of readFileSync(prodEnv, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const allPending = argv.includes('--all-pending');
const noPOArg = argv.find((a) => a.startsWith('--noPO='));
const noPO = noPOArg ? noPOArg.split('=')[1] : '';

loadEnv();

const uri = process.env.MONGO_URL;
const dbName = process.env.INVENTORY_DB_NAME || 'sppg_penarukan2';
if (!uri) process.exit(1);

async function pushGroup(db, po, vendorTenantId, items) {
  const tenantId = String(po.tenantId || 'sppg');
  const link = await db.collection('integration_links').findOne({
    customerTenantId: tenantId,
    vendorTenantId,
    status: { $ne: 'INACTIVE' },
  });
  const apiKey = link?.salesApiKey;
  if (!apiKey) return { error: `no API key for ${vendorTenantId}`, vendorTenantId };

  const res = await fetch(`${SALES_URL}/api/integrations/customer-po`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({
      customerTenantId: tenantId,
      vendorTenantId,
      noPO: po.noPO,
      customerPoId: po.id,
      tanggalKedatangan: po.tanggalKedatangan || po.tanggal,
      items,
      catatan: po.catatan || '',
      paymentTerms: po.paymentTerms || 'KREDIT',
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || `HTTP ${res.status}`, vendorTenantId };
  return { vendorTenantId, noSO: data.noSO, id: data.id, created: data.created };
}

async function syncPo(db, po) {
  const items = po.items || [];
  const byVendor = new Map();
  for (const it of items) {
    const v = String(it.vendorTenantId || 'default');
    if (!byVendor.has(v)) byVendor.set(v, []);
    byVendor.get(v).push(it);
  }
  const submissions = [];
  const failures = [];
  for (const [vendorTenantId, groupItems] of byVendor) {
    const r = await pushGroup(db, po, vendorTenantId, groupItems);
    if (r.error) failures.push(r);
    else submissions.push({
      vendorTenantId,
      status: 'SYNCED',
      vendorSoId: r.id,
      vendorNoSO: r.noSO,
    });
  }
  const now = new Date();
  const patch = {
    vendorSubmissions: [...submissions, ...failures.map((f) => ({
      vendorTenantId: f.vendorTenantId,
      status: 'FAILED',
      error: f.error,
    }))],
    updatedAt: now,
    vendorSyncAt: now,
    vendorSyncPending: failures.length > 0,
    vendorSyncError: failures.length
      ? failures.map((f) => `${f.vendorTenantId}: ${f.error}`).join('; ')
      : null,
  };
  if (submissions.length) {
    patch.status = 'SUBMITTED';
    patch.submittedAt = now;
    patch.vendorNoSO = submissions.map((s) => s.vendorNoSO).filter(Boolean).join(' · ');
    patch.vendorSyncPending = failures.length > 0;
  }
  await db.collection('customer_purchase_orders').updateOne({ id: po.id }, { $set: patch });
  return { submissions, failures };
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);

let filter = allPending
  ? { status: 'APPROVED', vendorSyncPending: { $ne: false } }
  : noPO
    ? { noPO }
    : null;

if (!filter) {
  console.error('Pakai --noPO=... atau --all-pending');
  process.exit(1);
}

const pos = await db.collection('customer_purchase_orders').find(filter).toArray();
console.log(`Found ${pos.length} PO(s)`);

for (const po of pos) {
  console.log(`\n--- ${po.noPO} status=${po.status} pending=${po.vendorSyncPending} ---`);
  if (!APPLY) {
    console.log('  vendors:', [...new Set((po.items || []).map((i) => i.vendorTenantId))]);
    continue;
  }
  const result = await syncPo(db, po);
  console.log('  synced:', result.submissions);
  if (result.failures.length) console.log('  failures:', result.failures);
}

if (!APPLY) console.log('\nDry-run. Tambahkan --apply untuk kirim ke sales.app');
await client.close();
