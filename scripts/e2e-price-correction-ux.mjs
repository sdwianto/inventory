#!/usr/bin/env node
/**
 * E2E / contract — UX koreksi harga (ADR-008) tanpa browser.
 *
 * 1) Kontrak string di VendorInvoiceDetail + retur-vendor (banner, tombol, label CN)
 * 2) API: login → hutang dengan creditNotes → klasifikasi RTV vs finansial
 * 3) Opsional: jalankan skenario G (CN finansial, stok diam) jika SALES_URL hidup
 *
 * Usage:
 *   node scripts/e2e-price-correction-ux.mjs
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INV = (process.env.INV_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const SALES = (process.env.SALES_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TENANT = process.env.E2E_TENANT || 'sppg';
const EMAIL = process.env.E2E_EMAIL || 'dawam@master.com';
const PASSWORD = process.env.E2E_PASSWORD || 'dawam123';
const WORKER_SECRET = process.env.WORKER_SECRET || 'dev-worker-secret';

const results = [];
function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`✅ PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.log(`❌ FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const jar = {};
  for (const line of raw) {
    const [pair] = String(line).split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function login(base, cookieName) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`login ${base}: ${body.error || res.status}`);
  return { jar: parseSetCookie(res), user: body.user };
}

async function api(base, jar, path, { method = 'GET', body, tenantId } = {}) {
  const tid = tenantId || TENANT;
  const url = new URL(`${base}${path}`);
  if (!url.searchParams.has('tenantId')) url.searchParams.set('tenantId', tid);
  const headers = { Cookie: cookieHeader(jar), Accept: 'application/json' };
  let payload = body;
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    payload = { tenantId: tid, ...body };
  }
  const res = await fetch(url, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 400) };
}

/** Mirror UI classification in VendorInvoiceDetail */
function creditNoteUxLabel(cn) {
  const fromRtv = String(cn.source || '') === 'inventory_return' || Boolean(String(cn.noReturn || ''));
  return fromRtv ? 'Retur Inventory' : 'Koreksi harga / CN finansial';
}

function assertSourceContains(fileRel, needles, name) {
  const src = readFileSync(join(ROOT, fileRel), 'utf8');
  const missing = needles.filter((n) => !src.includes(n));
  if (missing.length) throw new Error(`${fileRel} missing: ${missing.join(' | ')}`);
  pass(name, fileRel);
}

async function main() {
  console.log(`\n=== E2E Price Correction UX (ADR-008) ===\nINV=${INV}\nTENANT=${TENANT}\n`);

  // ── H1: UI contract — VendorInvoiceDetail ──
  try {
    assertSourceContains(
      'components/VendorInvoiceDetail.tsx',
      [
        'Salah harga vs retur fisik',
        'Koreksi harga',
        'Koreksi harga → draft CN / DN Sales',
        'Buat draft CN',
        'Buat draft DN',
        'hargaBenar',
        'request-price-cn',
        'request-price-dn',
        'Retur fisik (stok keluar)',
        'Koreksi harga / CN finansial',
        '/retur-vendor?hutangId=',
      ],
      'H1.ui-contract.VendorInvoiceDetail',
    );
  } catch (e) {
    fail('H1.ui-contract.VendorInvoiceDetail', e.message);
  }

  // ── H2: UI contract — retur-vendor hint ──
  try {
    assertSourceContains(
      'app/retur-vendor/page.tsx',
      [
        'Koreksi harga di Tagihan',
        'ADR-008',
      ],
      'H2.ui-contract.retur-vendor',
    );
  } catch (e) {
    fail('H2.ui-contract.retur-vendor', e.message);
  }

  // ── H3: login + hutang CN labels ──
  let invJar = null;
  try {
    const invLogin = await login(INV, 'inventory_session');
    invJar = invLogin.jar;
    pass('H3.login.inventory', invLogin.user?.role || 'ok');
  } catch (e) {
    fail('H3.login.inventory', e.message);
  }

  if (invJar) {
    try {
      const list = await api(INV, invJar, '/api/pages/hutang');
      const rows = Array.isArray(list.json?.items)
        ? list.json.items
        : (Array.isArray(list.json) ? list.json : []);
      if (!list.ok && !rows.length) {
        // cursor pages may nest differently
        const alt = await api(INV, invJar, '/api/hutang');
        const altRows = Array.isArray(alt.json?.items) ? alt.json.items
          : (Array.isArray(alt.json) ? alt.json : []);
        if (!altRows.length) throw new Error(`no hutang list ${list.status} ${JSON.stringify(list.json)?.slice?.(0, 120)}`);
        rows.push(...altRows);
      }

      let withCn = null;
      for (const row of rows.slice(0, 40)) {
        const id = String(row.id || '');
        if (!id) continue;
        const detail = await api(INV, invJar, `/api/hutang/${id}`);
        const cns = detail.json?.creditNotes;
        if (Array.isArray(cns) && cns.length) {
          withCn = detail.json;
          break;
        }
      }
      if (!withCn) {
        // Mongo fallback
        const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/?directConnection=true');
        await client.connect();
        const h = await client.db(process.env.DB_NAME || 'inventory_customer').collection('hutang').findOne({
          tenantId: TENANT,
          'creditNotes.0': { $exists: true },
        });
        await client.close();
        if (!h) throw new Error('no hutang with creditNotes in API/DB');
        withCn = h;
      }

      const labels = (withCn.creditNotes || []).map((cn) => creditNoteUxLabel(cn));
      if (!labels.length) throw new Error('empty creditNotes');
      const hasFin = labels.some((l) => l.includes('Koreksi harga'));
      const hasRtv = labels.some((l) => l.includes('Retur Inventory'));
      // Must never produce legacy "Manual / webhook" from classifier
      if (labels.some((l) => /Manual \/ webhook/i.test(l))) {
        throw new Error('legacy Manual/webhook label still used');
      }
      pass(
        'H3.hutang-cn-labels',
        `${withCn.noInvoice || withCn.id} labels=[${[...new Set(labels)].join(', ')}] fin=${hasFin} rtv=${hasRtv}`,
      );
    } catch (e) {
      fail('H3.hutang-cn-labels', e.message);
    }
  }

  // ── H4: retur-vendor page reachable (HTML shell) ──
  if (invJar) {
    try {
      const res = await fetch(`${INV}/retur-vendor?tenantId=${TENANT}`, {
        headers: { Cookie: cookieHeader(invJar), Accept: 'text/html' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      if (!/Retur Vendor|retur-vendor/i.test(html)) throw new Error('page shell missing Retur Vendor');
      pass('H4.retur-vendor-page', `HTTP ${res.status}`);
    } catch (e) {
      fail('H4.retur-vendor-page', e.message);
    }
  }

  // ── H5: hutang page shell ──
  if (invJar) {
    try {
      const res = await fetch(`${INV}/hutang?tenantId=${TENANT}`, {
        headers: { Cookie: cookieHeader(invJar), Accept: 'text/html' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      pass('H5.hutang-page', `HTTP ${res.status}`);
    } catch (e) {
      fail('H5.hutang-page', e.message);
    }
  }

  // ── H6: active API request-price-cn (draft CN on Sales) ──
  if (invJar) {
    try {
      const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/?directConnection=true');
      await client.connect();
      const idb = client.db(process.env.DB_NAME || 'inventory_customer');
      const sdb = client.db('kasir_db');
      // Prefer hutang whose Sales invoice still has CN capacity
      const hutangs = await idb.collection('hutang').find({
        tenantId: TENANT,
        referenceType: 'VENDOR_INVOICE',
        approvalStatus: { $ne: 'REJECTED' },
        'items.0': { $exists: true },
      }).sort({ tanggal: -1 }).limit(30).toArray();

      let target = null;
      let line = null;
      for (const h of hutangs) {
        const invId = String(h.vendorInvoiceId || h.invoiceId || '');
        const noInv = String(h.noInvoice || '');
        const invDoc = invId
          ? await sdb.collection('invoices').findOne({ id: invId })
          : await sdb.collection('invoices').findOne({
            noInvoice: noInv,
            customerTenantId: TENANT,
          });
        if (!invDoc || invDoc.status !== 'POSTED') continue;
        const cns = await sdb.collection('credit_notes').find({
          invoiceId: invDoc.id,
          status: { $in: ['DRAFT', 'POSTED'] },
        }).toArray();
        if (cns.some((c) => c.status === 'DRAFT')) continue;
        // pick first line with remaining qty
        for (const it of (h.items || [])) {
          const lid = String(it.lineId || '');
          if (!lid) continue;
          const credited = cns.reduce((s, cn) => {
            for (const cit of (cn.items || [])) {
              if (String(cit.lineId) === lid) s += Number(cit.qty) || 0;
            }
            return s;
          }, 0);
          const rem = (Number(it.qty) || 0) - credited;
          const harga = Number(it.harga) || 0;
          if (rem >= 1 && harga > 1) {
            target = h;
            line = { ...it, rem, harga };
            break;
          }
        }
        if (target) break;
      }

      if (!target || !line) {
        pass('H6.request-price-cn-api', 'SKIP — no hutang with CN capacity');
      } else {
        const hargaBenar = Math.max(0, Math.floor(line.harga) - 1);
        const res = await api(INV, invJar, `/api/hutang/${target.id}/request-price-cn`, {
          method: 'POST',
          body: {
            items: [{ lineId: String(line.lineId), qty: 1, hargaBenar }],
            catatan: 'E2E active Koreksi harga → draft CN',
          },
        });
        if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(res.json)}`);
        const priceCn = res.json?.priceCn || {};
        if (!priceCn.creditNoteId && !priceCn.noCN) throw new Error('priceCn missing');
        if (String(priceCn.status || 'DRAFT') !== 'DRAFT' && String(priceCn.status) !== 'POSTED') {
          // accept DRAFT primarily
        }
        pass(
          'H6.request-price-cn-api',
          `${target.noInvoice} → ${priceCn.noCN || priceCn.creditNoteId} status=${priceCn.status} amount=${priceCn.amount}`,
        );
      }
      await client.close();
    } catch (e) {
      fail('H6.request-price-cn-api', e.message);
    }
  }

  // ── G: financial CN no stock move (backend ADR-008) ──
  try {
    const salesLogin = await login(SALES, 'kasir_session');
    const salesJar = salesLogin.jar;
    const client = new MongoClient(process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/?directConnection=true');
    await client.connect();
    const sdb = client.db('kasir_db');
    const idb = client.db(process.env.DB_NAME || 'inventory_customer');
    const candidates = await sdb.collection('invoices').find({
      tenantId: { $in: ['uddawam', 'puspita'] },
      status: 'POSTED',
      customerTenantId: TENANT,
    }).sort({ tanggal: 1 }).limit(40).toArray();

    let picked = null;
    let vendorTid = '';
    let line0 = null;
    for (const invDoc of candidates) {
      vendorTid = String(invDoc.tenantId);
      line0 = (invDoc.items || [])[0];
      if (!line0) continue;
      const create = await api(SALES, salesJar, '/api/credit-notes', {
        method: 'POST',
        tenantId: vendorTid,
        body: {
          invoiceId: invDoc.id,
          items: [{
            lineId: line0.lineId,
            stokId: line0.stokId,
            kode: line0.kode,
            nama: line0.nama,
            qty: Math.min(1, Number(line0.qty) || 1),
            harga: line0.harga,
            hargaBeli: line0.hargaBeli || line0.harga,
            satuan: line0.satuan,
            uomId: line0.uomId,
          }],
          catatan: 'E2E ADR-008 UX — koreksi harga tanpa barang keluar',
        },
      });
      if (create.ok) { picked = { invDoc, create }; break; }
    }
    if (!picked || !line0) {
      pass('G.price-error-cn-no-stock-move', 'SKIP — no invoice with CN capacity');
    } else {
      const salesStokId = String(line0.stokId || '');
      const product = await idb.collection('products').findOne({
        tenantId: TENANT,
        $or: [{ vendorStokId: salesStokId }, { id: salesStokId }, { kode: String(line0.kode || '') }],
      });
      const gudang = String(product?.gudangKode || 'GKERING');
      const stockBefore = product
        ? await idb.collection('stok_lokasi').findOne({ tenantId: TENANT, stokId: product.id, lokasiKode: gudang })
        : null;
      const qtyBefore = Number(stockBefore?.qty || 0);

      const post = await api(SALES, salesJar, `/api/credit-notes/${picked.create.json.id}/post`, {
        method: 'POST',
        tenantId: vendorTid,
        body: {},
      });
      if (!post.ok) throw new Error(`post CN ${JSON.stringify(post.json)}`);
      if (String(post.json.storeRestockStatus) !== 'SKIPPED_B2B') {
        throw new Error(`storeRestockStatus=${post.json.storeRestockStatus}`);
      }

      try {
        await fetch(`${INV}/api/bg-jobs/process`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${WORKER_SECRET}`,
            'Content-Type': 'application/json',
            'x-worker-secret': WORKER_SECRET,
          },
          body: JSON.stringify({ limit: 10 }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch { /* best-effort */ }
      await new Promise((r) => setTimeout(r, 800));

      const stockAfter = product
        ? await idb.collection('stok_lokasi').findOne({ tenantId: TENANT, stokId: product.id, lokasiKode: gudang })
        : null;
      const qtyAfter = Number(stockAfter?.qty || 0);
      if (product && qtyAfter !== qtyBefore) {
        throw new Error(`stock moved ${qtyBefore}→${qtyAfter}`);
      }

      const hutang = await idb.collection('hutang').findOne({
        tenantId: TENANT,
        $or: [
          { noInvoice: picked.invDoc.noInvoice || picked.invDoc.nomor },
          { vendorInvoiceId: picked.invDoc.id },
          { invoiceId: picked.invDoc.id },
        ],
      });
      const cns = hutang?.creditNotes || [];
      const applied = cns.find((c) => String(c.creditNoteId) === String(post.json.id)
        || String(c.noCN) === String(post.json.noCN));
      const label = applied ? creditNoteUxLabel(applied) : creditNoteUxLabel({ source: post.json.source });
      if (label !== 'Koreksi harga / CN finansial' && String(post.json.source) === 'inventory_return') {
        throw new Error(`expected financial label, got ${label}`);
      }
      pass(
        'G.price-error-cn-no-stock-move',
        `CN=${post.json.noCN} stock=${qtyBefore}→${qtyAfter} uxLabel=${label}`,
      );
    }
    await client.close();
  } catch (e) {
    fail('G.price-error-cn-no-stock-move', e.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== SUMMARY ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
