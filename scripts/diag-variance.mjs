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

const noPO = process.argv[2] || 'CPO2606000002';
const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017');
await client.connect();
const db = client.db(process.env.DB_NAME || 'inventory_customer');

const po = await db.collection('customer_purchase_orders').findOne({ noPO });
const hutangs = await db.collection('hutang').find({ noPO, referenceType: 'VENDOR_INVOICE' }).toArray();
const grns = await db.collection('goods_receipts').find({ noPO, status: 'POSTED' }).toArray();

console.log(JSON.stringify({
  noPO,
  po: po ? {
    estimasiTotal: po.estimasiTotal,
    vendorSoSnapshot: po.vendorSoSnapshot,
    vendorSubmissions: po.vendorSubmissions,
    items: (po.items || []).map((i) => ({
      kode: i.kode || i.vendorKode,
      qty: i.qty,
      estimasiHarga: i.estimasiHarga,
      estimasiJumlah: i.estimasiJumlah,
    })),
  } : null,
  hutangs: hutangs.map((h) => ({
    noInvoice: h.noInvoice,
    total: h.total,
    soTotal: h.soTotal,
    poEstimasiTotal: h.poEstimasiTotal,
    variancePoToSo: h.variancePoToSo,
    varianceSoToInvoice: h.varianceSoToInvoice,
    vendorTenantId: h.vendorTenantId,
  })),
  grns: grns.map((g) => ({
    noGRN: g.noGRN,
    receivedTotal: g.receivedTotal,
    noInvoice: g.noInvoice,
    noDO: g.noDO,
  })),
}, null, 2));

await client.close();
