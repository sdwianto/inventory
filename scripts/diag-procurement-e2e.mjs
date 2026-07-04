#!/usr/bin/env node
/**
 * Procurement / integration E2E diagnostic (read-only).
 * Usage: node scripts/diag-procurement-e2e.mjs
 */
import { MongoClient } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TENANT = 'sppg';
const STUCK_RUNNING_MS = 10 * 60 * 1000;

function loadEnv() {
  try {
    const p = resolve(process.cwd(), '.env.local');
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = trimmed.match(/^([^=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* ignore */
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function iso(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function tenantRegex(tenant) {
  return new RegExp(`^${tenant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

async function checkHealth(name, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    console.log(JSON.stringify({ name, url, ok: res.ok, status: res.status, body }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ name, url, ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2));
  }
}

loadEnv();

const uri = process.env.MONGO_URL || process.env.MONGODB_URI || '';
const dbName = process.env.DB_NAME || 'inventory_customer';
const envSalesUrl = (process.env.SALES_APP_URL || '').replace(/\/$/, '');

section('CONFIG (no secrets)');
console.log(
  JSON.stringify(
    {
      dbName,
      hasMongoUrl: Boolean(uri),
      salesAppUrlFromEnv: envSalesUrl || '(unset)',
      customerTenantId: TENANT,
    },
    null,
    2,
  ),
);

if (!uri) {
  console.error('MONGO_URL missing in .env.local');
  process.exit(1);
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db(dbName);
await db.command({ ping: 1 });
console.log('MongoDB: connected');

const tidRegex = tenantRegex(TENANT);

section('DEAD-LETTER bg_jobs (FAILED + deadLetter)');
const deadLetters = await db
  .collection('bg_jobs')
  .find({ status: 'FAILED', deadLetter: true })
  .sort({ createdAt: -1 })
  .limit(50)
  .project({ type: 1, tenantId: 1, grnId: 1, lastError: 1, createdAt: 1, id: 1 })
  .toArray();
console.log(`count: ${deadLetters.length}${deadLetters.length === 50 ? ' (capped at 50)' : ''}`);
for (const j of deadLetters) {
  console.log(
    JSON.stringify({
      type: j.type,
      tenantId: j.tenantId,
      grnId: j.grnId ?? null,
      lastError: j.lastError,
      createdAt: iso(j.createdAt),
      jobId: j.id,
    }),
  );
}

section('RUNNING bg_jobs stuck > 10 min');
const stuckBefore = new Date(Date.now() - STUCK_RUNNING_MS);
const stuckJobs = await db
  .collection('bg_jobs')
  .find({
    status: 'RUNNING',
    $or: [
      { startedAt: { $lte: stuckBefore } },
      { startedAt: { $exists: false }, updatedAt: { $lte: stuckBefore } },
      { startedAt: null, updatedAt: { $lte: stuckBefore } },
    ],
  })
  .sort({ startedAt: 1, updatedAt: 1 })
  .limit(50)
  .project({ type: 1, tenantId: 1, grnId: 1, startedAt: 1, updatedAt: 1, attempts: 1, id: 1 })
  .toArray();
console.log(`count: ${stuckJobs.length}`);
for (const j of stuckJobs) {
  console.log(
    JSON.stringify({
      type: j.type,
      tenantId: j.tenantId,
      grnId: j.grnId ?? null,
      startedAt: iso(j.startedAt),
      updatedAt: iso(j.updatedAt),
      attempts: j.attempts,
      jobId: j.id,
    }),
  );
}

section(`integration_links (customerTenantId=${TENANT})`);
const links = await db
  .collection('integration_links')
  .find({ customerTenantId: tidRegex })
  .sort({ vendorTenantId: 1 })
  .project({ vendorTenantId: 1, salesAppUrl: 1, status: 1, vendorName: 1 })
  .toArray();
console.log(`count: ${links.length}`);
for (const l of links) {
  console.log(
    JSON.stringify({
      vendorTenantId: l.vendorTenantId,
      salesAppUrl: l.salesAppUrl,
      status: l.status,
      vendorName: l.vendorName,
    }),
  );
}

section('integration_settings salesAppUrl');
const settings = await db
  .collection('integration_settings')
  .find({ tenantId: tidRegex })
  .project({ tenantId: 1, salesAppUrl: 1, vendorTenantId: 1 })
  .toArray();
if (!settings.length) {
  console.log('(no integration_settings row for tenant)');
} else {
  for (const s of settings) {
    console.log(
      JSON.stringify({
        tenantId: s.tenantId,
        salesAppUrl: s.salesAppUrl,
        vendorTenantId: s.vendorTenantId,
      }),
    );
  }
}

section(`Procurement sample (${TENANT})`);

const poByStatus = await db
  .collection('customer_purchase_orders')
  .aggregate([
    { $match: { tenantId: tidRegex } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ])
  .toArray();
console.log('customer_purchase_orders by status:');
console.log(JSON.stringify(poByStatus.map((r) => ({ status: r._id, count: r.count })), null, 2));

const grnPostedNoInvoice = await db.collection('goods_receipts').countDocuments({
  tenantId: tidRegex,
  status: 'POSTED',
  $or: [{ noInvoice: { $exists: false } }, { noInvoice: null }, { noInvoice: '' }],
});
console.log(`goods_receipts POSTED without noInvoice: ${grnPostedNoInvoice}`);

const hutangPending = await db.collection('hutang').countDocuments({
  tenantId: tidRegex,
  $or: [{ approvalStatus: 'PENDING_REVIEW' }, { status: 'PENDING_REVIEW', approvalStatus: { $exists: false } }],
  $and: [{ $or: [{ referenceType: 'VENDOR_INVOICE' }, { vendorInvoiceId: { $exists: true, $ne: null } }] }],
});
console.log(`hutang PENDING_REVIEW (vendor): ${hutangPending}`);

const approvedVendorHutang = await db
  .collection('hutang')
  .find({
    tenantId: tidRegex,
    $or: [{ approvalStatus: 'APPROVED' }, { status: 'APPROVED', approvalStatus: { $exists: false } }],
    $and: [{ $or: [{ referenceType: 'VENDOR_INVOICE' }, { vendorInvoiceId: { $exists: true, $ne: null } }] }],
    noPO: { $exists: true, $nin: [null, ''] },
  })
  .project({
    noPO: 1,
    noInvoice: 1,
    vendorTenantId: 1,
    poEstimasiTotal: 1,
    total: 1,
    approvalStatus: 1,
  })
  .toArray();

const varianceIssues = [];
const vendorsByPo = new Map();
for (const h of approvedVendorHutang) {
  const noPO = String(h.noPO);
  const vendors = vendorsByPo.get(noPO) || new Set();
  if (h.vendorTenantId) vendors.add(String(h.vendorTenantId));
  vendorsByPo.set(noPO, vendors);

  const poEst = Number(h.poEstimasiTotal);
  const invTotal = Number(h.total);
  if (!Number.isFinite(poEst) || !Number.isFinite(invTotal) || invTotal <= 0) continue;
  if (poEst > invTotal * 2) {
    varianceIssues.push({
      noPO,
      noInvoice: h.noInvoice,
      vendorTenantId: h.vendorTenantId,
      poEstimasiTotal: poEst,
      invoiceTotal: invTotal,
      ratio: poEst / invTotal,
    });
  }
}

const multiVendorPoKeys = [...vendorsByPo.entries()]
  .filter(([, set]) => set.size > 1)
  .map(([noPO]) => noPO);
const varianceMultiVendor = varianceIssues.filter((v) => multiVendorPoKeys.includes(v.noPO));

console.log(`hutang APPROVED variance (poEstimasiTotal > invoiceTotal*2): ${varianceIssues.length}`);
console.log(`  of those on multi-vendor noPO: ${varianceMultiVendor.length}`);
if (varianceMultiVendor.length) {
  console.log(JSON.stringify(varianceMultiVendor.slice(0, 25), null, 2));
  if (varianceMultiVendor.length > 25) console.log(`(... ${varianceMultiVendor.length - 25} more)`);
}

section('Production health');
await checkHealth('penarukan2-inventory', 'https://penarukan2.vercel.app/api/health');
await checkHealth('sales-dawam', 'https://sales-dawam.vercel.app/api/health');

await client.close();
console.log('\nDone.');
