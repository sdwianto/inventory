/**
 * Perbaiki vendor_returns yang salah tersimpan dengan tenantId:'master' — bug lama di
 * POST /vendor-returns memakai auth mentah (bukan scopeAuth) saat resolve tenantIdForWrite,
 * jadi RTV yang dibuat sesi MASTER-acting-as-tenant tersimpan di tenant 'master', bukan
 * tenant yang sedang di-acting-kan. Skrip ini menyamakan tenantId RTV dengan tenantId
 * dokumen GRN/Hutang yang dirujuknya (sumber kebenaran, sudah pasti benar tenant-nya).
 * Jalankan: node scripts/fix-orphaned-tenant-vendor-returns.mjs [--apply] [--no-return=RTV2608000012]
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

const apply = process.argv.includes('--apply');
const noReturnArg = process.argv.find((a) => a.startsWith('--no-return='));
const onlyNoReturn = noReturnArg ? noReturnArg.split('=')[1] : null;

const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017');
await client.connect();
const db = client.db(process.env.DB_NAME || 'inventory_customer');

const filter = { tenantId: 'master', ...(onlyNoReturn ? { noReturn: onlyNoReturn } : {}) };
const stray = await db.collection('vendor_returns').find(filter).toArray();

if (!stray.length) {
  console.log('Tidak ada vendor_returns dengan tenantId:"master" yang cocok.');
  await client.close();
  process.exit(0);
}

let fixed = 0;
for (const rtv of stray) {
  let correctTenantId = null;
  if (rtv.grnId) {
    const grn = await db.collection('goods_receipts').findOne({ id: rtv.grnId });
    if (grn?.tenantId) correctTenantId = grn.tenantId;
  }
  if (!correctTenantId && rtv.hutangId) {
    const hutang = await db.collection('hutang').findOne({ id: rtv.hutangId });
    if (hutang?.tenantId) correctTenantId = hutang.tenantId;
  }
  if (!correctTenantId) {
    console.log(`${rtv.noReturn}: tidak ketemu GRN/Hutang rujukan — lewati (perbaiki manual)`);
    continue;
  }

  console.log(`${rtv.noReturn}: tenantId 'master' -> '${correctTenantId}'${apply ? ' (apply)' : ''}`);
  if (apply) {
    await db.collection('vendor_returns').updateOne(
      { id: rtv.id },
      { $set: { tenantId: correctTenantId, updatedAt: new Date() } },
    );
    fixed += 1;
  }
}

if (apply) {
  console.log('RTV diperbaiki:', fixed, '/', stray.length);
} else {
  console.log(`RTV terdampak: ${stray.length} — dry run, tambahkan --apply untuk menulis ke DB`);
}

await client.close();
