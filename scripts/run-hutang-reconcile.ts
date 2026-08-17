#!/usr/bin/env npx tsx
/**
 * Jalankan reconcileVendorHutangFromPostedGrns (lib/api/hutang-reconcile.ts) yang sesungguhnya
 * dipakai app — bukan scripts/backfix-vendor-hutang.mjs yang reimplementasi terpisah dan
 * belum ikut perbaikan qty/items per-baris.
 *
 *   npx tsx scripts/run-hutang-reconcile.ts --tenant=sppg
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { MongoClient } from 'mongodb';
import { reconcileVendorHutangFromPostedGrns } from '../lib/api/hutang-reconcile';

function loadEnv() {
  for (const name of ['.env.local', '.env.docker', '.env']) {
    const p = resolve(process.cwd(), name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
}
loadEnv();

const tenant = (process.argv.find((a) => a.startsWith('--tenant=')) || '').split('=')[1] || 'sppg';

async function main() {
  const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017');
  await client.connect();
  const db = client.db(process.env.DB_NAME || 'inventory_customer');

  const before = await db.collection('hutang').findOne({ noInvoice: 'INV2608000007' });
  console.log('Sebelum:', JSON.stringify({
    noInvoice: before?.noInvoice,
    total: before?.total,
    sisa: before?.sisa,
    items: (before?.items || []).map((it: Record<string, unknown>) => ({ lineId: it.lineId, nama: it.nama, qty: it.qty })),
  }));

  const result = await reconcileVendorHutangFromPostedGrns(db, tenant, {});
  console.log('\nHasil reconcile:', JSON.stringify(result));

  const after = await db.collection('hutang').findOne({ noInvoice: 'INV2608000007' });
  console.log('\nSesudah:', JSON.stringify({
    noInvoice: after?.noInvoice,
    total: after?.total,
    sisa: after?.sisa,
    items: (after?.items || []).map((it: Record<string, unknown>) => ({ lineId: it.lineId, nama: it.nama, qty: it.qty })),
  }));

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
