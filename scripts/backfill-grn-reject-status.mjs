/**
 * Backfill rejectStatus:'PENDING' pada baris GRN POSTED lama yang punya qtyRejected > 0
 * tapi belum punya rejectStatus (dibuat sebelum alur tindak lanjut item ditolak ada).
 * Jalankan: node scripts/backfill-grn-reject-status.mjs [--apply]
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

const grns = await db.collection('goods_receipts')
  .find({
    status: 'POSTED',
    items: {
      $elemMatch: {
        qtyRejected: { $gt: 0 },
        rejectStatus: { $exists: false },
      },
    },
  })
  .toArray();

let grnUpdated = 0;
let lineCount = 0;
for (const grn of grns) {
  const items = Array.isArray(grn.items) ? grn.items : [];
  const affected = items.filter((it) => (Number(it.qtyRejected) || 0) > 0 && it.rejectStatus === undefined);
  if (!affected.length) continue;
  lineCount += affected.length;
  console.log(`${grn.noGRN || grn.id}: ${affected.length} baris ditolak tanpa rejectStatus${apply ? ' (apply)' : ''}`);
  if (apply) {
    const nextItems = items.map((it) => (
      (Number(it.qtyRejected) || 0) > 0 && it.rejectStatus === undefined
        ? { ...it, rejectStatus: 'PENDING' }
        : it
    ));
    await db.collection('goods_receipts').updateOne(
      { id: grn.id },
      { $set: { items: nextItems, updatedAt: new Date() } },
    );
    grnUpdated += 1;
  }
}

if (apply) {
  console.log('GRN updated:', grnUpdated, '| Baris ditolak distempel PENDING:', lineCount);
} else {
  console.log(`GRN terdampak: ${grns.length} | Baris ditolak: ${lineCount}`);
  console.log('Dry run — tambahkan --apply untuk menulis ke DB');
}

await client.close();
