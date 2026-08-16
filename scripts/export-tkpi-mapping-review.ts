#!/usr/bin/env node
/**
 * Review mapping master produk → TKPI 2019 (top 3 saran).
 * Tidak menulis products.nutrition / tkpiCode ke DB.
 *
 *   npx tsx scripts/export-tkpi-mapping-review.ts
 *   npx tsx scripts/export-tkpi-mapping-review.ts --tenant=sppg-penarukan-2
 *   npx tsx scripts/export-tkpi-mapping-review.ts --from-json=/tmp/products.json --tenant=sppg-penarukan-2
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { MongoClient } from 'mongodb';
import * as XLSX from 'xlsx';
import { suggestTkpiMatches } from '../lib/food-production/tkpi-catalog';

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
  grup?: string;
  itemRole?: string;
  aktif?: boolean;
  tkpiCode?: string | null;
  nutrition?: { tkpiCode?: string | null } | null;
};

type ExportRow = {
  kode: string;
  nama: string;
  satuan: string;
  grup: string;
  itemRole: string;
  aktif: string;
  tkpiSudahTerpasang: string;
  status: 'unik' | 'ambigu' | 'tidak_ketemu';
  tkpi1_kode: string;
  tkpi1_nama: string;
  tkpi1_kelompok: string;
  tkpi1_kkal: number | '';
  tkpi2_kode: string;
  tkpi2_nama: string;
  tkpi2_kelompok: string;
  tkpi2_kkal: number | '';
  tkpi3_kode: string;
  tkpi3_nama: string;
  tkpi3_kelompok: string;
  tkpi3_kkal: number | '';
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
    : 'docs/akg/Review-Mapping-Produk-TKPI.xlsx',
);

const uri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'inventory_customer';

function slot(matches: ReturnType<typeof suggestTkpiMatches>, i: number) {
  const m = matches[i];
  return {
    kode: m?.kode || '',
    nama: m?.nama || '',
    kelompok: m?.kelompok || '',
    kkal: m ? m.energiKcal : ('' as const),
  };
}

function toExportRow(p: ProductRow): ExportRow {
  const matches = suggestTkpiMatches(String(p.nama || ''), 3);
  const status: ExportRow['status'] = matches.length === 0
    ? 'tidak_ketemu'
    : matches.length === 1
      ? 'unik'
      : 'ambigu';
  const a = slot(matches, 0);
  const b = slot(matches, 1);
  const c = slot(matches, 2);
  const attached = String(p.tkpiCode || p.nutrition?.tkpiCode || '').trim();
  return {
    kode: String(p.kode || ''),
    nama: String(p.nama || ''),
    satuan: String(p.satuan || ''),
    grup: String(p.grup || ''),
    itemRole: String(p.itemRole || ''),
    aktif: p.aktif === false ? 'Tidak' : 'Ya',
    tkpiSudahTerpasang: attached,
    status,
    tkpi1_kode: a.kode,
    tkpi1_nama: a.nama,
    tkpi1_kelompok: a.kelompok,
    tkpi1_kkal: a.kkal,
    tkpi2_kode: b.kode,
    tkpi2_nama: b.nama,
    tkpi2_kelompok: b.kelompok,
    tkpi2_kkal: b.kkal,
    tkpi3_kode: c.kode,
    tkpi3_nama: c.nama,
    tkpi3_kelompok: c.kelompok,
    tkpi3_kkal: c.kkal,
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
      grup: 1,
      itemRole: 1,
      aktif: 1,
      tkpiCode: 1,
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
  const unik = rows.filter((r) => r.status === 'unik');
  const ambigu = rows.filter((r) => r.status === 'ambigu');
  const miss = rows.filter((r) => r.status === 'tidak_ketemu');

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetFrom(rows), 'Semua');
  XLSX.utils.book_append_sheet(wb, sheetFrom(unik), 'Unik');
  XLSX.utils.book_append_sheet(wb, sheetFrom(ambigu), 'Ambigu');
  XLSX.utils.book_append_sheet(wb, sheetFrom(miss), 'Tidak_ketemu');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { metrik: 'caraReview', nilai: 'Pakai saran 1 kecuali saran 2/3 lebih tepat. Jangan terapkan ke DB dari file ini.' },
    { metrik: 'sumberTkpi', nilai: 'data/tkpi/tkpi-foods.json (TKPI 2019)' },
    { metrik: 'totalProduk', nilai: rows.length },
    { metrik: 'unik', nilai: unik.length },
    { metrik: 'ambigu', nilai: ambigu.length },
    { metrik: 'tidak_ketemu', nilai: miss.length },
    { metrik: 'tenantFilter', nilai: tenantId || '(semua)' },
    { metrik: 'source', nilai: fromJson || `${dbName} via Mongo` },
    { metrik: 'generatedAt', nilai: new Date().toISOString() },
  ]), 'Petunjuk');

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);

  console.log(JSON.stringify({
    out: outPath,
    total: rows.length,
    unik: unik.length,
    ambigu: ambigu.length,
    tidakKetemu: miss.length,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
