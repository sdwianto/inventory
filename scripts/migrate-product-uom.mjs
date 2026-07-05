#!/usr/bin/env node
/**
 * Migrasi produk existing → product_uom (satuan dasar, faktor 1).
 * Idempotent — aman dijalankan ulang.
 *
 * Usage: node scripts/migrate-product-uom.mjs [--dry-run]
 * Env: MONGO_URL, DB_NAME (atau dari .env.local)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const COL = 'product_uom';

function loadEnvLocal() {
  const p = resolve(root, '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

function legacyUomFromProduct(p) {
  return {
    satuan: String(p.satuan || 'PCS').trim().toUpperCase(),
    isBase: true,
    factorToBase: 1,
    barcode: String(p.barcode || '').trim(),
    sortOrder: 0,
    hargaEcer: parseInt(String(p.hargaEcer || p.vendorHargaEcer || 0), 10),
    hargaGrosir: parseInt(String(p.hargaGrosir || p.vendorHargaGrosir || 0), 10),
    hargaSpesial: parseInt(String(p.hargaSpesial || p.vendorHargaSpesial || 0), 10),
    aktif: p.aktif !== false,
  };
}

async function main() {
  loadEnvLocal();
  const url = process.env.MONGO_URL;
  const dbName = process.env.DB_NAME || 'inventory_customer';
  if (!url) {
    console.error('MONGO_URL wajib');
    process.exit(1);
  }

  const client = new MongoClient(url);
  await client.connect();
  const db = client.db(dbName);

  const products = await db.collection('products').find({}).toArray();
  let created = 0;
  let skipped = 0;
  let patched = 0;

  for (const p of products) {
    const tenantId = p.tenantId || 'default';
    const existing = await db.collection(COL).countDocuments({ tenantId, productId: p.id });
    if (existing > 0) {
      skipped += 1;
      if (!p.baseUomId) {
        const base = await db.collection(COL).findOne({ tenantId, productId: p.id, isBase: true });
        if (base && !DRY_RUN) {
          await db.collection('products').updateOne(
            { id: p.id },
            { $set: { baseUomId: base.id, updatedAt: new Date() } },
          );
          patched += 1;
        }
      }
      continue;
    }

    const input = legacyUomFromProduct(p);
    const uomId = uuidv4();
    const now = new Date();
    const doc = {
      id: uomId,
      tenantId,
      productId: p.id,
      ...input,
      createdAt: now,
      updatedAt: now,
    };

    if (!DRY_RUN) {
      await db.collection(COL).insertOne(doc);
      await db.collection('products').updateOne(
        { id: p.id },
        {
          $set: {
            baseUomId: uomId,
            satuan: input.satuan,
            barcode: input.barcode,
            updatedAt: now,
          },
        },
      );
    }
    created += 1;
  }

  if (!DRY_RUN) {
    await db.collection('system_meta').updateOne(
      { key: 'product_uom_migrated_v1' },
      { $set: { key: 'product_uom_migrated_v1', value: true, at: new Date() } },
      { upsert: true },
    );
  }

  console.log(JSON.stringify({
    dryRun: DRY_RUN,
    dbName,
    products: products.length,
    uomCreated: created,
    skippedExistingUom: skipped,
    baseUomIdPatched: patched,
  }, null, 2));

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
