#!/usr/bin/env node
/**
 * Procurement E2E smoke — production atau local.
 *
 * Usage:
 *   node scripts/procurement-e2e-test.mjs
 *   APP_URL=https://penarukan2.vercel.app SALES_APP_URL=https://sales-dawam.vercel.app node scripts/procurement-e2e-test.mjs
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MongoClient } from 'mongodb';

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

const APP_URL = (process.env.APP_URL || process.env.INVENTORY_APP_URL || 'https://penarukan2.vercel.app').replace(/\/$/, '');
const SALES_URL = (process.env.SALES_APP_URL || 'https://sales-dawam.vercel.app').replace(/\/$/, '');
const TENANT = process.env.E2E_TENANT || 'sppg';
const EMAIL = process.env.MASTER_EMAIL || process.env.ADMIN_EMAIL || 'master@sppg.com';
const PASSWORD = process.env.MASTER_PASSWORD || process.env.ADMIN_PASSWORD || 'master123';

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), ...opts });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { res, body };
}

async function testHealth() {
  for (const [label, base] of [['inventory', APP_URL], ['sales', SALES_URL]]) {
    const { res, body } = await fetchJson(`${base}/api/health`);
    record(
      `health:${label}`,
      res.ok && body?.status === 'ok' && body?.checks?.database === 'ok',
      `HTTP ${res.status} db=${body?.checks?.database} deadLetter=${body?.checks?.worker?.deadLetterCount ?? 0}`,
    );
  }
}

async function main() {
  console.log(`\n=== Procurement E2E ===\nAPP=${APP_URL}\nSALES=${SALES_URL}\nTENANT=${TENANT}\n`);

  const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
  let db = null;
  let client = null;
  if (uri) {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(process.env.DB_NAME || 'inventory_customer');
  }

  let loginEmail = EMAIL;
  if (db) {
    loginEmail = await loadLoginEmailFromDb(db);
    console.log(`Login email dari DB: ${loginEmail}`);
  }

  await testHealth();
  const session = await login(loginEmail);
  if (session) {
    await testProcurementReport(session);
    await testHutangPending(session);
  } else {
    record('api:procurement-expenses', false, 'skipped — login gagal');
    record('api:hutang-pending', false, 'skipped — login gagal');
  }
  await testSalesIntegration(db);
  if (db) await testMongoState(db);

  if (client) await client.close();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  if (failed.length) {
    console.log('Gagal:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

async function login(loginEmail = EMAIL) {
  const { res, body } = await fetchJson(`${APP_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: loginEmail, password: PASSWORD }),
  });
  const cookie = res.headers.get('set-cookie') || '';
  const sessionMatch = cookie.match(/session=([^;]+)/);
  record('auth:login', res.ok && !!sessionMatch, res.ok ? `user=${body?.user?.email || EMAIL}` : String(body?.error || res.status));
  return sessionMatch ? `session=${sessionMatch[1]}` : null;
}

async function testProcurementReport(sessionCookie) {
  const from = '2026-07-01';
  const to = '2026-07-31';
  const { res, body } = await fetchJson(
    `${APP_URL}/api/procurement-expenses?from=${from}&to=${to}&tenantId=${TENANT}`,
    { headers: { Cookie: sessionCookie } },
  );
  const rows = body?.rows || [];
  record('api:procurement-expenses', res.ok && Array.isArray(rows), `rows=${rows.length} approved=${body?.summary?.approvedTotal ?? 0}`);

  const multiPo = new Map();
  for (const r of rows) {
    if (!r.noPO) continue;
    if (!multiPo.has(r.noPO)) multiPo.set(r.noPO, []);
    multiPo.get(r.noPO).push(r);
  }
  let varianceOk = true;
  let varianceNote = 'no multi-vendor PO in period';
  for (const [noPO, group] of multiPo) {
    if (group.length < 2) continue;
    const estimasiSet = new Set(group.map((g) => g.poEstimasiTotal));
    if (estimasiSet.size === 1 && group[0].poEstimasiTotal > 0) {
      varianceOk = false;
      varianceNote = `${noPO}: semua baris estimasi sama (${group[0].poEstimasiTotal}) — harus per supplier`;
      break;
    }
    varianceNote = `${noPO}: ${group.length} supplier, estimasi berbeda ✓`;
  }
  record('procurement:multi-vendor-estimasi', varianceOk, varianceNote);
}

async function testHutangPending(sessionCookie) {
  const { res, body } = await fetchJson(
    `${APP_URL}/api/pages/hutang?approvalStatus=PENDING_REVIEW&tenantId=${TENANT}`,
    { headers: { Cookie: sessionCookie } },
  );
  const list = Array.isArray(body) ? body : (body?.data || body?.rows || []);
  record('api:hutang-pending', res.ok, `pending=${list.length}`);
}

async function loadSalesApiKeyFromDb(db) {
  const link = await db.collection('integration_links').findOne({ customerTenantId: TENANT });
  return link?.salesApiKey || process.env.SALES_API_KEY || '';
}

async function loadLoginEmailFromDb(db) {
  const user = await db.collection('users').findOne({
    tenantId: TENANT,
    role: { $in: ['MASTER', 'ADMIN', 'OWNER'] },
    aktif: { $ne: false },
  });
  return user?.email || EMAIL;
}

async function testSalesIntegration(db) {
  const apiKey = db ? await loadSalesApiKeyFromDb(db) : (process.env.SALES_API_KEY || '');
  if (!apiKey) {
    record('sales:customer-invoices', false, 'SALES_API_KEY tidak ada');
    return;
  }
  const { res, body } = await fetchJson(
    `${SALES_URL}/api/integrations/customer-invoices?customerTenantId=${encodeURIComponent(TENANT)}`,
    { headers: { 'X-Api-Key': apiKey } },
  );
  record(
    'sales:customer-invoices',
    res.ok,
    res.ok ? `invoices=${body?.count ?? body?.invoices?.length ?? '?'}` : String(body?.error || `HTTP ${res.status}`),
  );
}

async function testMongoState(db) {
  if (!db) {
    record('mongo:state', false, 'no db');
    return;
  }
  try {
    const dead = await db.collection('bg_jobs').countDocuments({ status: 'FAILED', deadLetter: true });
    const stuck = await db.collection('bg_jobs').countDocuments({
      status: 'RUNNING',
      updatedAt: { $lt: new Date(Date.now() - 15 * 60 * 1000) },
    });
    const localhostLinks = await db.collection('integration_links').countDocuments({
      customerTenantId: TENANT,
      salesAppUrl: { $regex: 'localhost', $options: 'i' },
    });
    const grnNoInv = await db.collection('goods_receipts').countDocuments({
      tenantId: TENANT,
      status: 'POSTED',
      $or: [{ noInvoice: { $exists: false } }, { noInvoice: null }, { noInvoice: '' }],
    });
    record('mongo:dead-letter', dead === 0, `count=${dead}`);
    record('mongo:stuck-running', stuck === 0, `count=${stuck}`);
    record('mongo:localhost-links', localhostLinks === 0, `count=${localhostLinks} (gunakan repair-procurement.mjs)`);
    record('mongo:grn-without-invoice', grnNoInv === 0, `count=${grnNoInv}`);
  } catch (e) {
    record('mongo:state', false, e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
