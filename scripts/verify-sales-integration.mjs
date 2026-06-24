#!/usr/bin/env node
/**
 * Verifikasi integrasi inventory ↔ sales.app
 * Usage: node scripts/verify-sales-integration.mjs [--tenant=sppg]
 */
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
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

const TENANT = (process.argv.find((a) => a.startsWith('--tenant=')) || '').split('=')[1] || 'sppg';
const salesUrl = (process.env.SALES_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const apiKey = process.env.SALES_API_KEY || '';
const vendorTenantId = process.env.SALES_VENDOR_TENANT_ID || 'default';

console.log('\n=== Verifikasi integrasi sales.app ===\n');
console.log({ salesUrl, vendorTenantId, customerTenantId: TENANT, hasApiKey: !!apiKey });

if (!apiKey) {
  console.error('FAIL: SALES_API_KEY tidak ada di .env.local');
  process.exit(1);
}

const headers = { 'X-Api-Key': apiKey };

async function check(name, url, opts = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000), ...opts });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const ok = res.ok;
    console.log(`${ok ? 'OK' : 'FAIL'} ${name}: HTTP ${res.status}${body?.error ? ` — ${body.error}` : ''}`);
    if (body && (body.count != null || body.invoices)) {
      console.log(`   → ${body.count ?? body.invoices?.length ?? 0} invoice(s) untuk ${TENANT}`);
    }
    return { ok, status: res.status, body };
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

await check(
  'customer-invoices',
  `${salesUrl}/api/integrations/customer-invoices?customerTenantId=${encodeURIComponent(TENANT)}`,
);

await check(
  'customer-shipments',
  `${salesUrl}/api/integrations/customer-shipments?customerTenantId=${encodeURIComponent(TENANT)}&limit=5`,
);

const uri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'inventory_customer';
const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(dbName);
  const tidRegex = new RegExp(`^${TENANT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

  const integration = await db.collection('integration_settings').findOne({ tenantId: tidRegex });
  console.log('\n--- integration_settings ---');
  console.log(integration ? {
    tenantId: integration.tenantId,
    salesAppUrl: integration.salesAppUrl,
    vendorTenantId: integration.vendorTenantId,
    hasKey: !!integration.salesApiKey,
  } : 'tidak ada — pakai .env.local');

  const postedNoInv = await db.collection('goods_receipts').countDocuments({
    tenantId: tidRegex,
    status: 'POSTED',
    noDO: { $exists: true, $ne: null },
    $or: [{ noInvoice: { $exists: false } }, { noInvoice: null }, { noInvoice: '' }],
  });
  console.log(`\nGRN POSTED tanpa noInvoice: ${postedNoInv}${postedNoInv ? ' → gunakan "Buat faktur" di Penerimaan' : ''}`);

  const pending = await db.collection('hutang').countDocuments({
    tenantId: tidRegex,
    $or: [{ approvalStatus: 'PENDING_REVIEW' }, { status: 'PENDING_REVIEW', approvalStatus: { $exists: false } }],
    $and: [{ $or: [{ referenceType: 'VENDOR_INVOICE' }, { vendorInvoiceId: { $exists: true, $ne: null } }] }],
  });
  console.log(`Tagihan menunggu review: ${pending}`);
} finally {
  await client.close();
}

console.log('\nPastikan di sales.app: Pelanggan B2B punya customerTenantId =', TENANT);
console.log('Dan DO sudah SHIPPED sebelum GRN POSTED / grn-posted.\n');
