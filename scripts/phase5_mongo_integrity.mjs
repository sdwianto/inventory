#!/usr/bin/env node
/**
 * MongoDB integrity checks for Phase 5.
 * Usage: node scripts/phase5_mongo_integrity.mjs [tenantA] [tenantB]
 * Env: MONGO_URL, DB_NAME (or load from .env.local)
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

const OPERATIONAL = [
  'transactions', 'pembelian', 'hutang', 'hutang_pembayaran', 'piutang', 'piutang_pembayaran',
  'stok_kartu', 'penyesuaian_stok', 'produksi', 'transfer_stok', 'jurnal', 'kas_masuk', 'kas_keluar',
  'retur_penjualan', 'retur_pembelian', 'aset_tetap', 'member_poin', 'penyusutan_log', 'tutup_buku_log',
];
const MASTER = ['products', 'supplier', 'pelanggan', 'members', 'rekening', 'lokasi'];

const tenantA = process.argv[2] || '';
const tenantB = process.argv[3] || '';

async function countMissingTenantId(col, extraFilter = {}) {
  return col.countDocuments({
    ...extraFilter,
    $or: [
      { tenantId: { $exists: false } },
      { tenantId: null },
      { tenantId: '' },
    ],
  });
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
  const report = { ok: true, collections: {}, crossTenant: {}, stokLokasi: {} };

  for (const name of [...OPERATIONAL, ...MASTER, 'stok_lokasi']) {
    const col = db.collection(name);
    const missing = await countMissingTenantId(col);
    const total = await col.estimatedDocumentCount();
    report.collections[name] = { total, missingTenantId: missing };
    if (missing > 0) report.ok = false;
  }

  // Recent auto journals should have tenantId
  const recentJurnal = await db.collection('jurnal')
    .find({ sourceType: { $regex: /^AUTO_/ } })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  const jurnalNoTenant = recentJurnal.filter((j) => !j.tenantId).length;
  report.collections.jurnal_auto_recent = {
    sampled: recentJurnal.length,
    missingTenantId: jurnalNoTenant,
  };
  if (jurnalNoTenant > 0) report.ok = false;

  if (tenantA && tenantB) {
    const prodA = await db.collection('products').countDocuments({ tenantId: tenantA });
    const prodB = await db.collection('products').countDocuments({ tenantId: tenantB });
    const jurnalA = await db.collection('jurnal').countDocuments({ tenantId: tenantA });
    const jurnalB = await db.collection('jurnal').countDocuments({ tenantId: tenantB });
    report.crossTenant = { tenantA, tenantB, prodA, prodB, jurnalA, jurnalB };

    const leakAinB = await db.collection('products').countDocuments({
      tenantId: tenantB,
      kode: { $regex: /^P5A-/ },
    });
    const leakBinA = await db.collection('products').countDocuments({
      tenantId: tenantA,
      kode: { $regex: /^P5B-/ },
    });
    report.crossTenant.markerLeakAinB = leakAinB;
    report.crossTenant.markerLeakBinA = leakBinA;
    if (leakAinB > 0 || leakBinA > 0) report.ok = false;
  }

  const stokRows = await db.collection('stok_lokasi').estimatedDocumentCount();
  report.stokLokasi.rows = stokRows;

  await client.close();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
  process.exit(2);
});
