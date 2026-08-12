#!/usr/bin/env node
/**
 * ADR-004 Fase 6 — backfill supplierId pada ingredient_lots dari GRN.
 * Default dry-run. --apply untuk menulis.
 *
 *   node scripts/migrate-ingredient-lot-supplier.mjs
 *   node scripts/migrate-ingredient-lot-supplier.mjs --tenant=t1 --apply
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

const apply = process.argv.includes('--apply');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const tenantId = tenantArg ? tenantArg.slice('--tenant='.length) : undefined;

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const dbName = process.env.MONGODB_DB || process.env.MONGO_DB || 'inventory';
  if (!uri) {
    console.error('MONGODB_URI wajib');
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const filter = {
    ...(tenantId ? { tenantId } : {}),
    $or: [
      { supplierId: { $exists: false } },
      { supplierId: null },
      { supplierId: '' },
    ],
  };

  const lots = await db.collection('ingredient_lots').find(filter).limit(5000).toArray();
  console.log(`Lots tanpa supplierId: ${lots.length} (apply=${apply})`);

  let updated = 0;
  let skipped = 0;
  for (const lot of lots) {
    if (!lot.grnId) {
      skipped += 1;
      continue;
    }
    const grn = await db.collection('goods_receipts').findOne({
      tenantId: lot.tenantId,
      id: lot.grnId,
    });
    if (!grn) {
      skipped += 1;
      continue;
    }
    const supplierId = String(grn.supplierId || grn.vendorTenantId || '').trim();
    if (!supplierId) {
      skipped += 1;
      continue;
    }
    if (apply) {
      await db.collection('ingredient_lots').updateOne(
        { tenantId: lot.tenantId, id: lot.id },
        { $set: { supplierId, updatedAt: new Date() } },
      );
    }
    updated += 1;
    console.log(`${apply ? 'UPDATE' : 'DRY'} ${lot.lotNo || lot.id} → ${supplierId}`);
  }

  console.log(`Done. wouldUpdate/updated=${updated} skipped=${skipped}`);
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
