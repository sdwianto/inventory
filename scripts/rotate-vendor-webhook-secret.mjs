#!/usr/bin/env node
/**
 * Ganti secret integrasi per pasangan vendor↔customer. Sales menandatangani semua panggilan ke
 * inventory (webhook & Category A) dengan secret link pasangan itu, jadi tiap pasangan diberi secret
 * unik sendiri. Link sisi sales dan sisi inventory diperbarui dalam SATU transaksi lintas database —
 * tidak ada jeda di mana panggilan ditolak 401. Secret baru tidak pernah dicetak.
 * Wajib: Sales sudah memakai secret link untuk webhook (resolveLinkedTargets) sebelum --apply.
 *
 * Usage:
 *   node scripts/rotate-vendor-webhook-secret.mjs --vendor=uddawam                      # dry-run, semua customer
 *   node scripts/rotate-vendor-webhook-secret.mjs --vendor=uddawam --customer=sppg --apply
 *   node scripts/rotate-vendor-webhook-secret.mjs --all --apply                         # semua link ACTIVE
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
const ALL = process.argv.includes('--all');
const vendor = arg('vendor').trim();
const customer = arg('customer').trim().toLowerCase();
const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
const invDbName = process.env.INVENTORY_DB_NAME || process.env.DB_NAME || 'inventory_customer';
const salesDbName = process.env.SALES_DB_NAME || 'kasir_db';

if (!uri) {
  console.error('MONGO_URL / MONGODB_URI tidak ada');
  process.exit(1);
}
if (!vendor && !ALL) {
  console.error('--vendor=<tenantId vendor> atau --all wajib');
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const inv = client.db(invDbName);
const sales = client.db(salesDbName);

try {
  const filter = {
    status: 'ACTIVE',
    ...(vendor ? { vendorTenantId: vendor } : {}),
    ...(customer ? { customerTenantId: customer } : {}),
  };
  const invLinks = await inv.collection('integration_links')
    .find(filter)
    .project({ customerTenantId: 1, vendorTenantId: 1, webhookSecret: 1 })
    .toArray();
  console.log(`DB sales=${salesDbName} inventory=${invDbName} pasangan: ${invLinks.length}`);
  if (!invLinks.length) throw new Error('Tidak ada link ACTIVE yang cocok di DB inventory');

  const plan = [];
  for (const l of invLinks) {
    const pair = `${l.vendorTenantId} -> ${l.customerTenantId}`;
    const salesLink = await sales.collection('integration_links').findOne({
      vendorTenantId: l.vendorTenantId, customerTenantId: l.customerTenantId, status: 'ACTIVE',
    }, { projection: { webhookSecret: 1 } });
    if (!salesLink) throw new Error(`${pair}: link sisi sales tidak ada — rapikan manual dulu`);
    if (!l.webhookSecret || salesLink.webhookSecret !== l.webhookSecret) {
      throw new Error(`${pair}: secret sales dan inventory tidak sama — rapikan manual dulu`);
    }
    const sharedWith = await inv.collection('integration_links').countDocuments({
      webhookSecret: l.webhookSecret, _id: { $ne: l._id },
    });
    plan.push({ link: l, pair, sharedWith });
    console.log(`  ${pair}: secret dipakai bersama ${sharedWith} link lain`);
  }

  if (!APPLY) {
    console.log('\nDry-run. Jalankan ulang dengan --apply untuk mengganti secret.');
  } else {
    let rotated = 0;
    for (const { link, pair } of plan) {
      const oldSecret = link.webhookSecret;
      const newSecret = randomBytes(24).toString('hex');
      const now = new Date();
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          const a = await inv.collection('integration_links').updateOne(
            { _id: link._id, webhookSecret: oldSecret, status: 'ACTIVE' },
            { $set: { webhookSecret: newSecret, updatedAt: now } },
            { session },
          );
          const b = await sales.collection('integration_links').updateOne(
            {
              vendorTenantId: link.vendorTenantId, customerTenantId: link.customerTenantId,
              webhookSecret: oldSecret, status: 'ACTIVE',
            },
            { $set: { webhookSecret: newSecret, updatedAt: now } },
            { session },
          );
          if (a.modifiedCount !== 1 || b.modifiedCount !== 1) throw new Error(`${pair}: link berubah saat rotasi — ulangi`);
        });
        rotated += 1;
        console.log(`  ${pair}: diganti (tidak dicetak)`);
      } finally {
        await session.endSession();
      }
    }
    console.log(`\nSelesai: ${rotated}/${plan.length} pasangan.`);
  }
} catch (e) {
  console.error(`GAGAL: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
