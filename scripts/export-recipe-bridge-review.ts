#!/usr/bin/env node
/**
 * Langkah 1 review resep: Excel master produk vs usulan infer dari nama.
 * Tidak menulis recipeBaseGrams/Ml ke DB.
 *
 *   npx tsx scripts/export-recipe-bridge-review.ts
 *   npx tsx scripts/export-recipe-bridge-review.ts --tenant=t1
 *   npx tsx scripts/export-recipe-bridge-review.ts --from-json=/tmp/products.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { MongoClient } from 'mongodb';
import * as XLSX from 'xlsx';
import { reviewRecipeBridge } from '../lib/food-production/recipe-uom';
import { recipeUomFamily } from '../lib/food-production/recipe-uom';

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

type ProductRow = {
  tenantId?: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  aktif?: boolean;
  recipeBaseGrams?: number | null;
  recipeBaseMl?: number | null;
  nutrition?: { gramsPerUnit?: number | null } | null;
};

type ExportRow = {
  tenantId: string;
  kode: string;
  nama: string;
  satuan: string;
  aktif: string;
  recipeBaseGrams: number | '';
  recipeBaseMl: number | '';
  nutritionGramsPerUnit: number | '';
  inferredGrams: number | '';
  inferredMl: number | '';
  factorSource: string;
  proposedKitchenDefault: string;
  uomFamily: string;
};

const args = process.argv.slice(2);
const tenantArg = args.find((a) => a.startsWith('--tenant='));
const tenantId = tenantArg ? tenantArg.slice('--tenant='.length).trim() : '';
const outArg = args.find((a) => a.startsWith('--out='));
const jsonArg = args.find((a) => a.startsWith('--from-json='));
const fromJson = jsonArg ? resolve(process.cwd(), jsonArg.slice('--from-json='.length).trim()) : '';
const outPath = resolve(
  process.cwd(),
  outArg
    ? outArg.slice('--out='.length).trim()
    : 'docs/konversi/Review-Recipe-Bridge.xlsx',
);

const uri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'inventory_customer';

function numOrBlank(value: unknown): number | '' {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : '';
}

function toExportRow(p: ProductRow): ExportRow {
  const review = reviewRecipeBridge(p);
  return {
    tenantId: String(p.tenantId || ''),
    kode: String(p.kode || ''),
    nama: String(p.nama || ''),
    satuan: String(p.satuan || ''),
    aktif: p.aktif === false ? 'Tidak' : 'Ya',
    recipeBaseGrams: numOrBlank(p.recipeBaseGrams),
    recipeBaseMl: numOrBlank(p.recipeBaseMl),
    nutritionGramsPerUnit: numOrBlank(p.nutrition?.gramsPerUnit),
    inferredGrams: review.inferredGrams ?? '',
    inferredMl: review.inferredMl ?? '',
    factorSource: review.factorSource,
    proposedKitchenDefault: review.proposedKitchenDefault,
    uomFamily: recipeUomFamily(p.satuan),
  };
}

function sheetFrom(rows: ExportRow[]) {
  return XLSX.utils.json_to_sheet(rows);
}

async function loadProducts(): Promise<ProductRow[]> {
  if (fromJson) {
    const parsed = JSON.parse(readFileSync(fromJson, 'utf8')) as ProductRow[];
    if (!Array.isArray(parsed)) throw new Error('--from-json harus array produk');
    return tenantId ? parsed.filter((p) => String(p.tenantId || '') === tenantId) : parsed;
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const filter: Record<string, unknown> = {};
  if (tenantId) filter.tenantId = tenantId;

  const products = await db.collection<ProductRow>('products')
    .find(filter)
    .project({
      tenantId: 1,
      kode: 1,
      nama: 1,
      satuan: 1,
      aktif: 1,
      recipeBaseGrams: 1,
      recipeBaseMl: 1,
      nutrition: 1,
    })
    .sort({ tenantId: 1, kode: 1 })
    .toArray();

  await client.close();
  return products;
}

async function main() {
  const products = await loadProducts();

  const rows = products.map(toExportRow);
  const inferred = rows.filter((r) => r.factorSource === 'inferred');
  const noneCount = rows.filter((r) => r.factorSource === 'none');
  const noneCountFamily = noneCount.filter((r) => r.uomFamily === 'COUNT');
  const master = rows.filter((r) => r.factorSource === 'master');

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFrom(rows), 'Semua');
  XLSX.utils.book_append_sheet(wb, sheetFrom(inferred), 'Usulan_infer');
  XLSX.utils.book_append_sheet(wb, sheetFrom(noneCountFamily), 'COUNT_tanpa_faktor');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { metrik: 'totalProduk', nilai: rows.length },
    { metrik: 'factorSource_master', nilai: master.length },
    { metrik: 'factorSource_inferred', nilai: inferred.length },
    { metrik: 'factorSource_none', nilai: noneCount.length },
    { metrik: 'COUNT_tanpa_faktor', nilai: noneCountFamily.length },
    { metrik: 'tenantFilter', nilai: tenantId || '(semua)' },
    { metrik: 'source', nilai: fromJson || `${dbName} via Mongo` },
    { metrik: 'generatedAt', nilai: new Date().toISOString() },
  ]), 'Ringkasan');

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);

  console.log(JSON.stringify({
    out: outPath,
    total: rows.length,
    master: master.length,
    inferred: inferred.length,
    none: noneCount.length,
    countTanpaFaktor: noneCountFamily.length,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
