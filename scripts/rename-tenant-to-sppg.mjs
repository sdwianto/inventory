#!/usr/bin/env node
/**
 * Migrasi / bersihkan tenant default → sppg.
 * Usage: node scripts/rename-tenant-to-sppg.mjs [--force]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const force = process.argv.includes('--force');
const FROM = 'default';
const TO = 'sppg';
const TENANT_DISPLAY_NAME = 'SPPG Penarukan 2';

const UNIQUE_KEY_FIELDS = {
  products: 'kode',
  supplier: 'kode',
  pelanggan: 'kode',
  members: 'kodeKartu',
  rekening: 'kode',
  lokasi: 'kode',
};

const COLLECTIONS = [
  'products', 'supplier', 'pelanggan', 'members', 'rekening', 'lokasi',
  'transactions', 'sales_orders', 'deliveries', 'invoices', 'purchase_orders',
  'pembelian', 'hutang', 'hutang_pembayaran', 'piutang', 'piutang_pembayaran',
  'stok_kartu', 'penyesuaian_stok', 'produksi', 'transfer_stok', 'jurnal',
  'kas_masuk', 'kas_keluar', 'retur_penjualan', 'retur_pembelian', 'aset_tetap',
  'member_poin', 'penyusutan_log', 'tutup_buku_log', 'stok_lokasi',
  'goods_receipts', 'vendor_product_map', 'webhook_inbox',
  'customer_price_lists', 'document_sequences', 'users',
];

const SETTINGS_COLLECTION = 'tenant_settings';

async function migrateCollection(db, name) {
  const keyField = UNIQUE_KEY_FIELDS[name];
  const defaultDocs = await db.collection(name).find({ tenantId: FROM }).toArray();
  if (!defaultDocs.length) return { moved: 0, deleted: 0 };

  let moved = 0;
  let deleted = 0;
  for (const doc of defaultDocs) {
    if (keyField && doc[keyField] != null) {
      const dup = await db.collection(name).findOne({ tenantId: TO, [keyField]: doc[keyField] });
      if (dup) {
        await db.collection(name).deleteOne({ _id: doc._id });
        deleted += 1;
        continue;
      }
    }
    await db.collection(name).updateOne({ _id: doc._id }, { $set: { tenantId: TO } });
    moved += 1;
  }
  return { moved, deleted };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }),
);

const client = new MongoClient(env.MONGO_URL);
await client.connect();
const db = client.db(env.DB_NAME || 'inventory_customer');

let leftovers = await db.collection(SETTINGS_COLLECTION).countDocuments({ tenantId: FROM });
for (const name of COLLECTIONS) {
  leftovers += await db.collection(name).countDocuments({ tenantId: FROM });
}

const logCol = db.collection('app_migrations');
const done = await logCol.findOne({ id: 'default-to-sppg', done: true });

if (done && leftovers === 0 && !force) {
  const legacy = await db.collection('tenant_settings').findOne({ tenantId: FROM });
  if (legacy) {
    const target = await db.collection('tenant_settings').findOne({ tenantId: TO });
    const patch = {};
    if (legacy.logoBase64 && !target?.logoBase64) patch.logoBase64 = legacy.logoBase64;
    if (Object.keys(patch).length) {
      await db.collection('tenant_settings').updateOne({ tenantId: TO }, { $set: patch });
    }
    await db.collection('tenant_settings').deleteMany({ tenantId: FROM });
    console.log(JSON.stringify({ cleaned: true, removedLegacySettings: true }, null, 2));
  } else {
    console.log(JSON.stringify({ skipped: true, reason: 'already migrated' }, null, 2));
  }
  await client.close();
  process.exit(0);
}

const counts = {};
for (const name of COLLECTIONS) {
  const r = await migrateCollection(db, name);
  if (r.moved || r.deleted) counts[name] = r;
}

await db.collection('users').updateMany({ tenantId: TO }, { $set: { tenantName: TENANT_DISPLAY_NAME } });

const legacy = await db.collection('tenant_settings').findOne({ tenantId: FROM });
const target = await db.collection('tenant_settings').findOne({ tenantId: TO });
if (legacy) {
  const patch = {};
  if (legacy.logoBase64 && !target?.logoBase64) patch.logoBase64 = legacy.logoBase64;
  if (legacy.companyAddress && !target?.companyAddress) patch.companyAddress = legacy.companyAddress;
  if (legacy.companyPhone && !target?.companyPhone) patch.companyPhone = legacy.companyPhone;
  if (legacy.companyNPWP && !target?.companyNPWP) patch.companyNPWP = legacy.companyNPWP;
  if (Object.keys(patch).length) {
    await db.collection('tenant_settings').updateOne({ tenantId: TO }, { $set: patch }, { upsert: true });
  }
}
await db.collection('tenant_settings').deleteMany({ tenantId: FROM });

await db.collection('tenant_settings').updateOne(
  { tenantId: TO },
  { $set: { companyName: TENANT_DISPLAY_NAME, tenantName: TENANT_DISPLAY_NAME, updatedAt: new Date() } },
  { upsert: true },
);

await logCol.updateOne(
  { id: 'default-to-sppg' },
  { $set: { done: true, at: new Date(), counts, force } },
  { upsert: true },
);

console.log(JSON.stringify({ migrated: true, counts, leftoversBefore: leftovers }, null, 2));
await client.close();
