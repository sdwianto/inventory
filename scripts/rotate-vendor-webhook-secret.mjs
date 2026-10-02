#!/usr/bin/env node
/**
 * Ganti secret webhook satu vendor sales → inventory (secret dipakai per vendor, untuk semua customer).
 * Sisi sales (webhook_subscriptions + integration_links vendor) dan sisi inventory (integration_links)
 * diperbarui dalam SATU transaksi lintas database — tidak ada jeda di mana webhook ditolak 401.
 * Secret baru tidak pernah dicetak.
 *
 * Usage:
 *   node scripts/rotate-vendor-webhook-secret.mjs --vendor=uddawam                 # dry-run
 *   node scripts/rotate-vendor-webhook-secret.mjs --vendor=uddawam --apply
 *   node scripts/rotate-vendor-webhook-secret.mjs --vendor=uddawam --url=https://inv.example.com/api/webhooks/sales --apply
 *
 * Env: MONGO_URL, DB_NAME (inventory), SALES_DB_NAME (sales). Sales & inventory wajib di cluster Mongo yang sama.
 */
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
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

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) || '';
const APPLY = process.argv.includes('--apply');
const vendor = arg('vendor').trim();
const urlFilter = arg('url').trim();
const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
const invDbName = process.env.INVENTORY_DB_NAME || process.env.DB_NAME || 'inventory_customer';
const salesDbName = process.env.SALES_DB_NAME || 'kasir_db';

if (!uri) {
  console.error('MONGO_URL / MONGODB_URI tidak ada');
  process.exit(1);
}
if (!vendor) {
  console.error('--vendor=<tenantId vendor> wajib');
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const inv = client.db(invDbName);
const sales = client.db(salesDbName);

try {
  const subs = await sales.collection('webhook_subscriptions')
    .find({ tenantId: vendor, aktif: { $ne: false }, ...(urlFilter ? { url: urlFilter } : {}) })
    .project({ id: 1, event: 1, url: 1, secret: 1 })
    .toArray();
  const urls = [...new Set(subs.map((s) => s.url))];
  const secrets = [...new Set(subs.map((s) => s.secret).filter(Boolean))];
  console.log(`DB sales=${salesDbName} inventory=${invDbName} vendor=${vendor}`);
  console.log(`subscription aktif: ${subs.length}, url: ${JSON.stringify(urls)}, secret berbeda: ${secrets.length}`);

  if (!subs.length) throw new Error('Tidak ada subscription aktif untuk vendor ini');
  if (urls.length > 1) throw new Error('Subscription ke lebih dari satu URL — pilih satu dengan --url=');
  if (secrets.length !== 1) throw new Error('Secret subscription tidak tunggal — rapikan manual dulu');
  const oldSecret = secrets[0];

  const invLinks = await inv.collection('integration_links')
    .find({ vendorTenantId: vendor, webhookSecret: oldSecret })
    .project({ customerTenantId: 1, status: 1 })
    .toArray();
  const salesLinks = await sales.collection('integration_links')
    .find({ vendorTenantId: vendor, webhookSecret: oldSecret })
    .project({ customerTenantId: 1, status: 1 })
    .toArray();
  const sharedWith = await inv.collection('integration_links').distinct('vendorTenantId', {
    webhookSecret: oldSecret, vendorTenantId: { $ne: vendor },
  });
  console.log(`link inventory: ${invLinks.map((l) => `${l.customerTenantId}/${l.status}`).join(', ') || '-'}`);
  console.log(`link vendor di sales: ${salesLinks.map((l) => `${l.customerTenantId}/${l.status}`).join(', ') || '-'}`);
  console.log(`vendor lain yang memakai secret sama: ${sharedWith.join(', ') || '-'} (tidak diubah)`);
  if (!invLinks.length) {
    throw new Error('Tidak ada link inventory dengan secret ini di DB inventory — URL subscription mungkin ke instance lain');
  }

  if (!APPLY) {
    console.log('\nDry-run. Jalankan ulang dengan --apply untuk mengganti secret.');
  } else {
    const newSecret = randomBytes(16).toString('hex');
    const now = new Date();
    const session = client.startSession();
    let counts;
    try {
      await session.withTransaction(async () => {
        const subIds = subs.map((s) => s.id);
        const a = await sales.collection('webhook_subscriptions').updateMany(
          { id: { $in: subIds }, secret: oldSecret },
          { $set: { secret: newSecret, updatedAt: now } },
          { session },
        );
        if (a.modifiedCount !== subIds.length) throw new Error('Subscription berubah saat rotasi — ulangi');
        const b = await inv.collection('integration_links').updateMany(
          { vendorTenantId: vendor, webhookSecret: oldSecret },
          { $set: { webhookSecret: newSecret, updatedAt: now } },
          { session },
        );
        const c = await sales.collection('integration_links').updateMany(
          { vendorTenantId: vendor, webhookSecret: oldSecret },
          { $set: { webhookSecret: newSecret, updatedAt: now } },
          { session },
        );
        counts = { subscriptions: a.modifiedCount, inventoryLinks: b.modifiedCount, salesLinks: c.modifiedCount };
      });
    } finally {
      await session.endSession();
    }
    console.log(`\nSecret diganti (tidak dicetak): ${JSON.stringify(counts)}`);
  }
} catch (e) {
  console.error(`GAGAL: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
