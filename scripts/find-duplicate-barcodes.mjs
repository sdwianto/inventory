#!/usr/bin/env node
/**
 * Cari produk aktif dengan barcode sama dalam satu tenant (duplikat SKU dari sync sales.app).
 * Default: laporan saja (dry-run). Pakai --apply untuk nonaktifkan duplikat (bukan hapus),
 * menyisakan satu "keeper" per grup barcode.
 *
 * Usage:
 *   node scripts/find-duplicate-barcodes.mjs                 # laporan semua tenant
 *   node scripts/find-duplicate-barcodes.mjs <tenantId>       # laporan satu tenant
 *   node scripts/find-duplicate-barcodes.mjs <tenantId> --apply
 *
 * Env: MONGO_URL, DB_NAME (dimuat dari .env.local jika ada)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

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

loadEnvLocal();

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const tenantArg = args.find((a) => !a.startsWith('--'));

/** Keeper = paling layak dipertahankan: stok terbanyak, lalu hargaBeli>0 (ada riwayat GRN), lalu paling lama dibuat. */
function pickKeeper(group) {
  return [...group].sort((a, b) => {
    const stokA = Number(a.stok || 0);
    const stokB = Number(b.stok || 0);
    if (stokA !== stokB) return stokB - stokA;
    const hbA = Number(a.hargaBeli || 0) > 0 ? 1 : 0;
    const hbB = Number(b.hargaBeli || 0) > 0 ? 1 : 0;
    if (hbA !== hbB) return hbB - hbA;
    const caA = a.createdAt ? new Date(a.createdAt).getTime() : Infinity;
    const caB = b.createdAt ? new Date(b.createdAt).getTime() : Infinity;
    return caA - caB;
  })[0];
}

async function main() {
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  const dbName = process.env.DB_NAME || 'kasir_db';
  if (!uri) {
    console.log(JSON.stringify({ ok: false, error: 'MONGO_URL not set' }));
    process.exit(2);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const col = db.collection('products');

  const filter = {
    aktif: { $ne: false },
    barcode: { $exists: true, $ne: '' },
    ...(tenantArg ? { tenantId: tenantArg } : {}),
  };

  const rows = await col.find(filter).project({
    id: 1, tenantId: 1, barcode: 1, kode: 1, nama: 1, satuan: 1, grup: 1,
    stok: 1, hargaBeli: 1, vendorTenantId: 1, vendorStokId: 1, createdAt: 1,
  }).toArray();

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.tenantId}::${r.barcode}`;
    const arr = groups.get(key) || [];
    arr.push(r);
    groups.set(key, arr);
  }

  const dupGroups = [...groups.entries()].filter(([, arr]) => arr.length > 1);

  console.log(`Tenant scope: ${tenantArg || '(semua)'} — ${rows.length} produk aktif berbarcode diperiksa.`);
  console.log(`Ditemukan ${dupGroups.length} grup barcode duplikat.\n`);

  let deactivatedTotal = 0;
  for (const [key, group] of dupGroups) {
    const [tenantId, barcode] = key.split('::');
    const keeper = pickKeeper(group);
    const losers = group.filter((r) => r.id !== keeper.id);

    console.log(`[${tenantId}] barcode ${barcode} — ${group.length} produk:`);
    for (const r of group) {
      const mark = r.id === keeper.id ? 'KEEP  ' : 'DEACT ';
      console.log(`  ${mark} kode=${r.kode} nama="${r.nama}" satuan=${r.satuan} grup=${r.grup} stok=${r.stok} hargaBeli=${r.hargaBeli} vendorTenantId=${r.vendorTenantId} id=${r.id}`);
    }

    if (apply) {
      const ids = losers.map((r) => r.id);
      const now = new Date();
      const res = await col.updateMany(
        { id: { $in: ids } },
        { $set: { aktif: false, barcodeDuplicateOf: keeper.id, barcodeDuplicateWarning: false, deactivatedReason: 'barcode_duplicate_cleanup', updatedAt: now } },
      );
      deactivatedTotal += res.modifiedCount;
      await col.updateOne({ id: keeper.id }, { $set: { barcodeDuplicateWarning: false, barcodeDuplicateOf: null, updatedAt: now } });
    }
    console.log('');
  }

  if (apply) {
    console.log(`Selesai — ${deactivatedTotal} produk duplikat dinonaktifkan (aktif:false, bukan dihapus).`);
  } else {
    console.log('Dry-run — tidak ada perubahan. Jalankan ulang dengan --apply untuk nonaktifkan duplikat (produk KEEP tidak disentuh, produk DEACT diset aktif:false, stok & histori tetap ada).');
  }

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
