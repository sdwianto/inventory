#!/usr/bin/env node
/**
 * Hapus semua data master produk + pembelian (dan turunannya) untuk testing bersih.
 * Usage: node scripts/purge-products-pembelian.mjs
 */
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

loadEnvLocal();

const uri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'kasir_db';

async function run() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const counts = {};

  const hutangPembelian = await db.collection('hutang')
    .find({ $or: [{ referenceType: 'PEMBELIAN' }, { noPembelian: { $exists: true, $ne: '' } }] })
    .project({ id: 1 })
    .toArray();
  const hutangIds = hutangPembelian.map((h) => h.id).filter(Boolean);

  if (hutangIds.length > 0) {
    counts.hutang_pembayaran = (await db.collection('hutang_pembayaran')
      .deleteMany({ hutangId: { $in: hutangIds } })).deletedCount;
  } else {
    counts.hutang_pembayaran = 0;
  }

  counts.hutang = (await db.collection('hutang').deleteMany({
    $or: [{ referenceType: 'PEMBELIAN' }, { noPembelian: { $exists: true, $ne: '' } }],
  })).deletedCount;

  counts.retur_pembelian = (await db.collection('retur_pembelian').deleteMany({})).deletedCount;
  counts.pembelian = (await db.collection('pembelian').deleteMany({})).deletedCount;
  counts.stok_kartu_pembelian = (await db.collection('stok_kartu')
    .deleteMany({ sourceType: 'PEMBELIAN' })).deletedCount;
  counts.jurnal_beli = (await db.collection('jurnal')
    .deleteMany({ sourceType: 'AUTO_BELI' })).deletedCount;
  counts.stok_lokasi = (await db.collection('stok_lokasi').deleteMany({})).deletedCount;
  counts.products = (await db.collection('products').deleteMany({})).deletedCount;

  console.log('Pembersihan selesai:', JSON.stringify(counts, null, 2));
  await client.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
