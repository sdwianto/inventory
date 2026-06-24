#!/usr/bin/env node
import { MongoClient } from 'mongodb';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

function loadEnv() {
  try {
    const p = resolve(process.cwd(), '.env.local');
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* ignore */ }
}
loadEnv();

const out = [];
const log = (x) => out.push(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

const uri = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'inventory_customer';
const salesUrl = (process.env.SALES_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const apiKey = process.env.SALES_API_KEY || '';

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);

log('=== DIAG HUTANG DEEP ===');
log({ dbName, salesUrl, hasApiKey: !!apiKey });

const allHutang = await db.collection('hutang').find({}).sort({ createdAt: -1 }).limit(20).toArray();
log(`\nTotal hutang (all types): ${await db.collection('hutang').countDocuments()}`);
log(`Vendor hutang: ${await db.collection('hutang').countDocuments({ $or: [{ referenceType: 'VENDOR_INVOICE' }, { vendorInvoiceId: { $exists: true, $ne: null } }] })}`);
for (const h of allHutang) {
  log({
    noHutang: h.noHutang, noInvoice: h.noInvoice, noDO: h.noDO,
    tenantId: h.tenantId, approvalStatus: h.approvalStatus, status: h.status,
    referenceType: h.referenceType, vendorInvoiceId: h.vendorInvoiceId, total: h.total,
  });
}

const grns = await db.collection('goods_receipts').find({ status: 'POSTED' }).sort({ postedAt: -1 }).limit(10).toArray();
log(`\nPOSTED GRNs: ${grns.length}`);
for (const g of grns) {
  log({
    noGRN: g.noGRN, noDO: g.noDO, noInvoice: g.noInvoice,
    hutangId: g.hutangId, vendorInvoiceId: g.vendorInvoiceId,
    tenantId: g.tenantId, receivedTotal: g.receivedTotal, noPO: g.noPO,
  });
}

const tenants = await db.collection('goods_receipts').distinct('tenantId');
log(`\nGRN tenantIds: ${JSON.stringify(tenants)}`);

// Test sales grn-posted for first GRN without hutang
const target = grns.find((g) => !g.hutangId && g.noDO);
if (target && apiKey) {
  log(`\nTesting grn-posted for ${target.noGRN} / ${target.noDO}`);
  const tid = String(target.tenantId || 'sppg').toLowerCase();
  const payload = {
    customerTenantId: tid,
    vendorTenantId: target.vendorTenantId || process.env.SALES_VENDOR_TENANT_ID || 'default',
    noDO: target.noDO,
    noSO: target.noSO || null,
    noGRN: target.noGRN,
    grnId: target.id,
    noPO: target.noPO || null,
    postedAt: target.postedAt || new Date().toISOString(),
    receivedTotal: target.receivedTotal || 0,
    items: (target.items || []).map((it) => ({
      kode: it.vendorKode || it.localKode,
      qty: it.qtyReceived ?? it.qtyOrdered ?? 0,
      harga: it.harga || it.hargaSatuan || 0,
    })),
  };
  try {
    const res = await fetch(`${salesUrl}/api/integrations/grn-posted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    log({ grnPostedStatus: res.status, body });
  } catch (e) {
    log({ grnPostedError: e.message });
  }
} else if (!apiKey) {
  log('\nSKIP grn-posted test: no SALES_API_KEY');
} else {
  log('\nAll POSTED GRNs already have hutangId or no DO');
}

await client.close();
writeFileSync(resolve(process.cwd(), 'diag-hutang-output.json'), out.join('\n'));
console.log('Wrote diag-hutang-output.json');
