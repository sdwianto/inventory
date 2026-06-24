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

const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017');
await client.connect();
const db = client.db(process.env.DB_NAME || 'inventory_customer');

const all = await db.collection('hutang').find({ referenceType: 'VENDOR_INVOICE' }).sort({ tanggal: -1 }).limit(20).toArray();
console.log('ALL VENDOR HUTANG', all.length);
for (const h of all) {
  console.log({
    noInvoice: h.noInvoice,
    noDO: h.noDO,
    tenantId: h.tenantId,
    approvalStatus: h.approvalStatus,
    status: h.status,
    total: h.total,
    terbayar: h.terbayar,
    paidExternalAt: h.paidExternalAt,
    vendorInvoiceId: h.vendorInvoiceId,
  });
}

const pending = await db.collection('hutang').find({
  referenceType: 'VENDOR_INVOICE',
  $or: [
    { approvalStatus: 'PENDING_REVIEW' },
    { status: 'PENDING_REVIEW', approvalStatus: { $exists: false } },
  ],
}).toArray();
console.log('PENDING filter count', pending.length);

const grns = await db.collection('goods_receipts').find({ status: 'POSTED' }).sort({ postedAt: -1 }).limit(5).toArray();
console.log('RECENT POSTED GRNs');
for (const g of grns) {
  console.log({
    noGRN: g.noGRN,
    noDO: g.noDO,
    noInvoice: g.noInvoice,
    hutangId: g.hutangId,
    receivedTotal: g.receivedTotal,
    tenantId: g.tenantId,
  });
}

await client.close();
