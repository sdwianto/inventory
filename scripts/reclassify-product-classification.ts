#!/usr/bin/env npx tsx
/**
 * Reclassify itemRole + gudangKode Inventory dari grup/nama.
 * SKU classificationSource=manual dan Barang Jadi dilewati.
 * Qty gudang lama dipindah ke gudang baru + jejak kartu stok.
 *
 *   npx tsx scripts/reclassify-product-classification.ts
 *   npx tsx scripts/reclassify-product-classification.ts --apply
 *   npx tsx scripts/reclassify-product-classification.ts --apply --tenant=sppg
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { MongoClient } from 'mongodb';
import { reclassifyProductsForTenant } from '../lib/api/apply-product-classification';

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
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[k]) process.env[k] = v;
    }
  }
}
loadEnv();

const apply = process.argv.includes('--apply');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const tenantFilter = tenantArg ? tenantArg.slice('--tenant='.length).trim() : '';
const uri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'inventory_customer';

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const tenantIds = tenantFilter
    ? [tenantFilter]
    : ((await db.collection('products').distinct('tenantId')) as string[]).filter(Boolean);

  console.log(apply ? 'APPLY' : 'DRY-RUN', { db: dbName, tenants: tenantIds.length });
  for (const tid of tenantIds) {
    const result = await reclassifyProductsForTenant(db, tid, { dryRun: !apply });
    console.log(tid, {
      products: result.products,
      updated: result.updated,
      skipped: result.skipped,
      relocated: result.relocated,
    });
    for (const row of result.changes.slice(0, 15)) {
      if (row.skipped) continue;
      console.log(
        `  ${row.kode} ${row.nama} grup=${row.fromGrup} role ${row.itemRole || '-'}→${row.nextRole} gudang ${row.gudangKode || '-'}→${row.nextGudang}`,
      );
    }
  }
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
