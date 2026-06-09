#!/usr/bin/env node
/**
 * Migrasi: set tenantId='default' pada master data yang belum punya field.
 * Lalu buat indeks unik compound per tenant.
 *
 * Usage: node scripts/migrate-add-tenantId.js
 * Env: MONGO_URL, DB_NAME (sama dengan .env.local)
 */

const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs');

function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
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
const DEFAULT_TENANT = 'default';

const COLLECTIONS = [
  'products', 'supplier', 'pelanggan', 'members', 'rekening', 'lokasi',
  'transactions', 'pembelian', 'hutang', 'hutang_pembayaran', 'piutang', 'piutang_pembayaran',
  'stok_kartu', 'penyesuaian_stok', 'produksi', 'transfer_stok', 'jurnal',
  'kas_masuk', 'kas_keluar', 'retur_penjualan', 'retur_pembelian', 'aset_tetap',
  'member_poin', 'penyusutan_log', 'tutup_buku_log',
];

const INDEXES = [
  { collection: 'products', key: { tenantId: 1, kode: 1 } },
  { collection: 'supplier', key: { tenantId: 1, kode: 1 } },
  { collection: 'pelanggan', key: { tenantId: 1, kode: 1 } },
  { collection: 'members', key: { tenantId: 1, kodeKartu: 1 } },
  { collection: 'rekening', key: { tenantId: 1, kode: 1 } },
  { collection: 'lokasi', key: { tenantId: 1, kode: 1 } },
];

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  console.log(`Connected to ${dbName}`);

  for (const name of COLLECTIONS) {
    const res = await db.collection(name).updateMany(
      {
        $or: [
          { tenantId: { $exists: false } },
          { tenantId: null },
          { tenantId: '' },
        ],
      },
      { $set: { tenantId: DEFAULT_TENANT } },
    );
    console.log(`${name}: ${res.modifiedCount} dokumen → tenantId="${DEFAULT_TENANT}"`);
  }

  for (const { collection, key } of INDEXES) {
    try {
      const name = `uniq_${collection}_tenant`;
      await db.collection(collection).createIndex(key, { unique: true, name });
      console.log(`Index OK: ${collection} ${JSON.stringify(key)}`);
    } catch (e) {
      console.error(`Index GAGAL ${collection}:`, e.message);
      if (e.code === 11000) {
        console.error('  → Ada duplikat (tenantId+kode) dalam satu tenant. Perbaiki data lalu jalankan lagi.');
      }
    }
  }

  await client.close();
  console.log('Selesai.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
