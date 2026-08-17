/**
 * Perbaiki dua akibat dari bug tenantId RTV yang sudah diperbaiki di kode:
 *
 * 1. Sinkronkan counter document_sequences (RTV) per tenant ke angka noReturn tertinggi
 *    yang benar-benar terpakai di vendor_returns tenant itu. Diperlukan karena
 *    fix-orphaned-tenant-vendor-returns.mjs mengubah tenantId dokumen lama dari 'master' ke
 *    tenant asli tanpa menyesuaikan counter tenant asli — counter itu mulai dari 0 lagi,
 *    sehingga RTV baru bisa dapat noReturn yang SAMA dengan dokumen lama (tabrakan unique
 *    index tenantId+noReturn) dan gagal insert.
 *
 * 2. Cari baris GRN dengan rejectStatus:'RTV_CREATED' yang rejectRtvId-nya TIDAK match RTV
 *    manapun di vendor_returns (klaim berhasil tapi insert RTV gagal, sebelum kode di-fix
 *    supaya kedua tulisan ini atomik) — kembalikan ke rejectStatus:'PENDING' supaya bisa
 *    dicoba lagi dari awal.
 *
 * Jalankan: node scripts/fix-rtv-sequence-and-stuck-claims.mjs [--apply]
 */
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv() {
  try {
    const p = resolve(process.cwd(), '.env.local');
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
}
loadEnv();

const apply = process.argv.includes('--apply');
const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017');
await client.connect();
const db = client.db(process.env.DB_NAME || 'inventory_customer');

console.log('--- 1. Sinkronkan counter document_sequences (RTV) ---');
const rtvs = await db.collection('vendor_returns').find({}).project({ tenantId: 1, noReturn: 1 }).toArray();
const maxByTenant = new Map();
for (const r of rtvs) {
  const m = String(r.noReturn || '').match(/(\d{6})$/);
  if (!m) continue;
  const n = parseInt(m[1], 10);
  const tid = String(r.tenantId || 'default');
  maxByTenant.set(tid, Math.max(maxByTenant.get(tid) || 0, n));
}
let seqFixed = 0;
for (const [tid, maxN] of maxByTenant) {
  const seq = await db.collection('document_sequences').findOne({ tenantId: tid, docType: 'RTV' });
  const current = Number(seq?.lastNumber || 0);
  if (current >= maxN) {
    console.log(`tenant ${tid}: counter=${current} sudah >= noReturn tertinggi terpakai (${maxN}) — aman`);
    continue;
  }
  console.log(`tenant ${tid}: counter ${current} -> ${maxN}${apply ? ' (apply)' : ''}`);
  if (apply) {
    await db.collection('document_sequences').updateOne(
      { tenantId: tid, docType: 'RTV' },
      { $set: { lastNumber: maxN, prefix: 'RTV', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    seqFixed += 1;
  }
}

console.log('\n--- 2. Cari baris GRN RTV_CREATED yang RTV-nya tidak pernah benar-benar ada ---');
const rtvIds = new Set((await db.collection('vendor_returns').find({}).project({ id: 1 }).toArray()).map((r) => r.id));
const grns = await db.collection('goods_receipts').find({
  items: { $elemMatch: { rejectStatus: 'RTV_CREATED' } },
}).toArray();

let staleLines = 0;
for (const grn of grns) {
  for (const it of (grn.items || [])) {
    if (it.rejectStatus !== 'RTV_CREATED') continue;
    if (rtvIds.has(it.rejectRtvId)) continue; // RTV really exists — fine.
    staleLines += 1;
    console.log(`${grn.noGRN} / ${it.localNama} (lineId ${it.lineId}): rejectRtvId=${it.rejectRtvId} tidak ditemukan di vendor_returns -> revert ke PENDING${apply ? ' (apply)' : ''}`);
    if (apply) {
      await db.collection('goods_receipts').updateOne(
        { id: grn.id, 'items.lineId': it.lineId },
        {
          $set: { 'items.$.rejectStatus': 'PENDING' },
          $unset: { 'items.$.rejectRtvId': '', 'items.$.rejectNoReturn': '' },
        },
      );
    }
  }
}

console.log(`\nRingkasan: counter diperbaiki=${apply ? seqFixed : maxByTenant.size + ' kandidat dicek'}, baris GRN macet=${staleLines}`);
if (!apply) console.log('Dry run — tambahkan --apply untuk menulis ke DB');

await client.close();
