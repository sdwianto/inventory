#!/usr/bin/env node
/**
 * Recipe Kitchen UOM — backfill qtyBase* pada baris resep lama.
 *
 * Resep historis menyimpan qty dalam satuan basis produk (satuan = products.satuan).
 * Setelah fitur satuan dapur, MRP/issue membaca qtyBaseBesar / qtyBaseKecil.
 * Backfill: qtyBase* = qty dapur, factorToBase = 1, baseSatuan = satuan.
 *
 * Master data (manual, di luar skrip ini):
 *   Untuk bahan ber-base SAK / BTL / IKAT / PACK yang sering diisi dapur dalam GR/ML,
 *   isi products.recipeBaseGrams (1 base = N gram) atau products.recipeBaseMl,
 *   atau nutrition.gramsPerUnit. Tanpa faktor eksplisit, konversi GR→SAK ditolak.
 *
 * Dry-run adalah default. Tambahkan --apply untuk menulis.
 *
 *   node scripts/backfill-recipe-qty-base.mjs
 *   node scripts/backfill-recipe-qty-base.mjs --tenant=t1 --apply
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

const COLLECTION = 'recipes';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const tenantArg = args.find((a) => a.startsWith('--tenant='));
const tenantId = tenantArg ? tenantArg.slice('--tenant='.length).trim() : '';

const uri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'inventory_customer';

function needsBackfill(line) {
  if (!line || typeof line !== 'object') return false;
  const hasBase =
    line.qtyBaseBesar != null
    && Number.isFinite(Number(line.qtyBaseBesar))
    && line.factorToBase != null
    && Number.isFinite(Number(line.factorToBase));
  return !hasBase;
}

function patchLine(line) {
  const qtyBesar = Number(line.qtyBesar ?? line.qty) || 0;
  const pctKecil = Number(line.pctKecil);
  const qtyKecil = line.qtyKecil != null && Number.isFinite(Number(line.qtyKecil))
    ? Number(line.qtyKecil)
    : (Number.isFinite(pctKecil) && pctKecil > 0
      ? Math.round((qtyBesar * pctKecil / 100 + Number.EPSILON) * 1e6) / 1e6
      : qtyBesar);
  const satuan = line.satuan != null ? String(line.satuan).trim() : '';
  return {
    ...line,
    qtyBaseBesar: qtyBesar,
    qtyBaseKecil: qtyKecil,
    factorToBase: 1,
    baseSatuan: satuan || line.baseSatuan || undefined,
  };
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const col = db.collection(COLLECTION);

  const scope = tenantId ? { tenantId } : {};
  const recipes = await col
    .find(scope)
    .project({ id: 1, tenantId: 1, kode: 1, lines: 1 })
    .toArray();

  let recipesTouched = 0;
  let linesPatched = 0;
  const samples = [];

  for (const doc of recipes) {
    const lines = Array.isArray(doc.lines) ? doc.lines : [];
    let changed = false;
    const nextLines = lines.map((line) => {
      if (!needsBackfill(line)) return line;
      changed = true;
      linesPatched += 1;
      return patchLine(line);
    });
    if (!changed) continue;
    recipesTouched += 1;
    if (samples.length < 15) {
      samples.push({
        id: doc.id,
        kode: doc.kode,
        tenantId: doc.tenantId,
        linesNeeding: lines.filter(needsBackfill).length,
      });
    }
    if (apply) {
      await col.updateOne(
        { _id: doc._id },
        {
          $set: {
            lines: nextLines,
            updatedAt: new Date().toISOString(),
          },
        },
      );
    }
  }

  console.log('--- Recipe qtyBase backfill ---');
  console.log('mode           :', apply ? 'APPLY' : 'DRY-RUN (tambahkan --apply untuk menulis)');
  console.log('mongo          :', uri.replace(/\/\/([^@/]+)@/, '//***@'));
  console.log('db             :', dbName);
  console.log('tenant         :', tenantId || '(semua)');
  console.log('recipes scanned:', recipes.length);
  console.log('recipes touched:', recipesTouched);
  console.log('lines patched  :', linesPatched);
  if (samples.length) {
    console.log('samples:');
    for (const s of samples) {
      console.log(`  ${s.kode || s.id} tenant=${s.tenantId} lines=${s.linesNeeding}`);
    }
  }
  console.log('');
  console.log('Catatan master: isi recipeBaseGrams / recipeBaseMl pada produk SAK/BTL/IKAT');
  console.log('bila dapur mengisi GR/ML — tanpa itu konversi ke basis kemasan ditolak.');

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
