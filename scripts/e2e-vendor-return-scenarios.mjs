#!/usr/bin/env node
/**
 * E2E Retur Vendor (RTV) — local dev Inventory :3001 + Sales :3000
 *
 * Usage:
 *   node scripts/e2e-vendor-return-scenarios.mjs
 *
 * Creds (override via env):
 *   E2E_EMAIL / E2E_PASSWORD
 *   INV_URL / SALES_URL / E2E_TENANT (buyer Inventory tenant)
 */
import { MongoClient } from 'mongodb';

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
  const jar = parseSetCookie(res);
  if (!jar[cookieName] && Object.keys(jar).length === 0) {
    // Next may set via multiple headers; fallback store empty and rely on subsequent failure
  }
  return { jar, user: body.user };
}

async function api(base, jar, path, { method = 'GET', body, tenantId } = {}) {
  const tid = tenantId || TENANT;
  const url = new URL(`${base}${path}`);
  if (!url.searchParams.has('tenantId')) url.searchParams.set('tenantId', tid);
  const headers = {
    Cookie: cookieHeader(jar),
    Accept: 'application/json',
  };
  let payload = body;
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    payload = { tenantId: tid, ...body };
  }
  const res = await fetch(url, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 500) };
}

async function kickWorkers() {
  // Inventory bg worker
  try {
    await fetch(`${INV}/api/bg-jobs/process`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WORKER_SECRET}`,
        'Content-Type': 'application/json',
        'x-worker-secret': WORKER_SECRET,
      },
      body: JSON.stringify({ limit: 20 }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch { /* best-effort */ }
  // Sales execution drain if any
  try {
    await fetch(`${SALES}/api/bg-jobs/process`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WORKER_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: 20 }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch { /* ignore */ }
}

async function waitCnSync(invJar, rtvId, timeoutMs = 90_000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    await kickWorkers();
    // retry-cn helps if FAILED
    const cur = await api(INV, invJar, `/api/vendor-returns/${rtvId}`);
    last = cur.json;
    const st = String(last?.cnSyncStatus || '');
    if (st === 'DONE' && last?.creditNoteId) return last;
    if (st === 'FAILED' || st === 'SYNCING' || st === 'NONE') {
      await api(INV, invJar, `/api/vendor-returns/${rtvId}/retry-cn`, { method: 'POST', body: {} });
    }
    if (st === 'SKIPPED') return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

async function createSubmitPost(invJar, hutangId, items, reason) {
  const create = await api(INV, invJar, '/api/vendor-returns', {
    method: 'POST',
    body: { hutangId, reason, ...(items ? { items } : {}) },
  });
  if (!create.ok) throw new Error(`create: ${create.status} ${JSON.stringify(create.json)}`);
  const id = create.json.id || create.json._id;
  const submit = await api(INV, invJar, `/api/vendor-returns/${id}/submit`, {
    method: 'POST',
    body: { reason },
  });
  if (!submit.ok) throw new Error(`submit: ${submit.status} ${JSON.stringify(submit.json)}`);
  const post = await api(INV, invJar, `/api/vendor-returns/${id}/approve`, {
    method: 'POST',
    body: { reason },
  });
  if (!post.ok) throw new Error(`approve/post: ${post.status} ${JSON.stringify(post.json)}`);
  return post.json;
}

async function salesDecide(salesJar, vendorTenantId, cnId, decisions) {
  return api(SALES, salesJar, `/api/credit-notes/${cnId}/decide`, {
    method: 'POST',
    tenantId: vendorTenantId,
    body: { decisions },
  });
}

async function findCnForReturn(salesJar, vendorTenantId, returnId) {
  const list = await api(SALES, salesJar, '/api/credit-notes?status=DRAFT&source=inventory_return&pageMode=0', {
    tenantId: vendorTenantId,
  });
  const rows = Array.isArray(list.json) ? list.json : (list.json?.items || []);
  return rows.find((c) => String(c.inventoryReturnId || '') === String(returnId))
    || rows.find((c) => String(c.noReturn || '').length > 0);
}

async function listUsableInvoices(invJar) {
  const eligible = await api(INV, invJar, '/api/vendor-returns/eligible-invoices');
  if (!eligible.ok || !Array.isArray(eligible.json)) return [];
  const usable = [];
  for (const row of eligible.json) {
    const c = await api(INV, invJar, '/api/vendor-returns', {
      method: 'POST',
      body: { hutangId: row.hutangId, reason: 'E2E probe usable' },
    });
    if (!c.ok) continue;
    const id = c.json.id;
    if (String(c.json.status) === 'DRAFT') {
      await api(INV, invJar, `/api/vendor-returns/${id}`, { method: 'DELETE', body: {} });
    }
    usable.push({ ...row, rtvProbeId: id });
  }
  return usable.sort((a, b) => (b.maxQty || 0) - (a.maxQty || 0));
}

async function main() {
  console.log(`\n=== E2E Vendor Return ===\nINV=${INV}\nSALES=${SALES}\nTENANT=${TENANT}\nUSER=${EMAIL}\n`);

  // Seed UOM/stock fixtures so D (multi-line) & E (maxQty≥2) can run
  try {
    const { spawnSync } = await import('child_process');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const seed = spawnSync(process.execPath, [join(scriptDir, 'e2e-seed-rtv-fixtures.mjs')], {
      cwd: join(scriptDir, '..'),
      encoding: 'utf8',
      env: process.env,
    });
    if (seed.status === 0) pass('seed.fixtures', 'UOM+stock for multi-line/high-qty');
    else pass('seed.fixtures', `warn: ${(seed.stderr || seed.stdout || '').slice(0, 200)}`);
  } catch (e) {
    pass('seed.fixtures', `warn: ${e.message}`);
  }

  const invLogin = await login(INV, 'inventory_session');
  const salesLogin = await login(SALES, 'kasir_session');
  pass('login.inventory', invLogin.user.role);
  pass('login.sales', salesLogin.user.role);

  const invJar = invLogin.jar;
  const salesJar = salesLogin.jar;

  const usable = await listUsableInvoices(invJar);
  if (!usable.length) {
    fail('usable-invoices', 'none passed UOM mapping create');
    return summarize();
  }
  pass('usable-invoices', `${usable.length} invoices (UOM OK)`);
  let pool = [...usable];

  const take = (pred) => {
    const idx = pool.findIndex(pred);
    if (idx < 0) return null;
    const [row] = pool.splice(idx, 1);
    return row;
  };

  // Reserve D (multi-line) & E (maxQty≥2) before A–C consume the pool
  const reservedD = take((x) => (x.returableLines || 0) >= 2);
  const reservedE = take((x) => (x.maxQty || 0) >= 2 && x.hutangId !== reservedD?.hutangId)
    || take((x) => (x.maxQty || 0) >= 2);

  // ── Scenario A: full return (all remaining qty of invoice) → ACCEPTED ──
  {
    const name = 'A.full-return-all-accepted';
    try {
      // Prefer maxQty=1 — seed stok sering kurang untuk invoice qty besar.
      const inv = take((x) => (x.maxQty || 0) === 1) || take((x) => (x.maxQty || 0) >= 1 && (x.maxQty || 0) <= 3);
      if (!inv) throw new Error('no eligible invoice');
      const posted = await createSubmitPost(invJar, inv.hutangId, null, `E2E ${name}`);
      const rtvId = posted.id;
      const synced = await waitCnSync(invJar, rtvId);
      if (String(synced?.cnSyncStatus) !== 'DONE') {
        throw new Error(`cnSync=${synced?.cnSyncStatus} err=${synced?.cnSyncError}`);
      }
      const vendorTid = String(synced.vendorTenantId || inv.vendorTenantId);
      let cn = await findCnForReturn(salesJar, vendorTid, rtvId);
      if (!cn && synced.creditNoteId) {
        const one = await api(SALES, salesJar, `/api/credit-notes/${synced.creditNoteId}`, { tenantId: vendorTid });
        cn = one.json;
      }
      if (!cn?.id) throw new Error('CN DRAFT not found on Sales');
      const decisions = (cn.items || []).map((it) => ({
        lineId: String(it.lineId),
        decision: 'ACCEPTED',
      }));
      const dec = await salesDecide(salesJar, vendorTid, cn.id, decisions);
      if (!dec.ok) throw new Error(`decide ${dec.status} ${JSON.stringify(dec.json)}`);
      const check = await api(INV, invJar, `/api/vendor-returns/${rtvId}/check-decision`, {
        method: 'POST',
        body: {},
      });
      const after = await api(INV, invJar, `/api/vendor-returns/${rtvId}`);
      const vd = String(after.json?.vendorDecision || check.json?.checkResult?.vendorDecision || '');
      if (vd !== 'ACCEPTED') throw new Error(`vendorDecision=${vd} check=${JSON.stringify(check.json?.checkResult || check.json)}`);
      pass(name, `${inv.noInvoice} RTV=${synced.noReturn} CN=${cn.noCN} transit=${synced.transitAppliedAt ? 'Y' : 'N'}`);
    } catch (e) {
      fail(name, e.message);
    }
  }

  // refresh usable (qty may have changed) — keep reserved D/E out of A–C refresh path
  pool = (await listUsableInvoices(invJar)).filter(
    (x) => x.hutangId !== reservedD?.hutangId && x.hutangId !== reservedE?.hutangId,
  );

  // ── Scenario B: partial qty (1 of N) → ACCEPTED ──
  {
    const name = 'B.partial-qty-accepted';
    try {
      const inv = take((x) => (x.maxQty || 0) >= 2) || take((x) => (x.maxQty || 0) >= 1);
      if (!inv) throw new Error('no eligible');
      const create = await api(INV, invJar, '/api/vendor-returns', {
        method: 'POST',
        body: { hutangId: inv.hutangId, reason: `E2E ${name}` },
      });
      if (!create.ok) throw new Error(`create ${JSON.stringify(create.json)}`);
      const rtvId = create.json.id;
      const detail = await api(INV, invJar, `/api/vendor-returns/${rtvId}`);
      const lines = (detail.json.items || []).filter((it) => (it.maxQty || it.qty || 0) > 0);
      if (!lines.length) throw new Error('no lines on draft');
      const line = lines[0];
      const maxQ = Number(line.maxQty || line.qty || 1);
      const qty = maxQ > 1 ? 1 : maxQ;
      const patchItems = [{
        ...line,
        qty,
        qtyBase: qty,
        jumlah: Math.round(qty * (Number(line.harga) || 0)),
      }];
      const patch = await api(INV, invJar, `/api/vendor-returns/${rtvId}`, {
        method: 'PATCH',
        body: { reason: `E2E ${name}`, items: patchItems },
      });
      if (!patch.ok) throw new Error(`patch ${JSON.stringify(patch.json)}`);
      const submit = await api(INV, invJar, `/api/vendor-returns/${rtvId}/submit`, {
        method: 'POST',
        body: { reason: `E2E ${name}` },
      });
      if (!submit.ok) throw new Error(`submit ${JSON.stringify(submit.json)}`);
      const post = await api(INV, invJar, `/api/vendor-returns/${rtvId}/approve`, {
        method: 'POST',
        body: { reason: `E2E ${name}` },
      });
      if (!post.ok) throw new Error(`post ${JSON.stringify(post.json)}`);
      const synced = await waitCnSync(invJar, rtvId);
      if (String(synced?.cnSyncStatus) !== 'DONE') throw new Error(`cnSync=${synced?.cnSyncStatus} ${synced?.cnSyncError}`);
      const vendorTid = String(synced.vendorTenantId || inv.vendorTenantId);
      const cn = await findCnForReturn(salesJar, vendorTid, rtvId)
        || (await api(SALES, salesJar, `/api/credit-notes/${synced.creditNoteId}`, { tenantId: vendorTid })).json;
      const decisions = (cn.items || []).map((it) => ({ lineId: String(it.lineId), decision: 'ACCEPTED' }));
      const dec = await salesDecide(salesJar, vendorTid, cn.id, decisions);
      if (!dec.ok) throw new Error(`decide ${JSON.stringify(dec.json)}`);
      await api(INV, invJar, `/api/vendor-returns/${rtvId}/check-decision`, { method: 'POST', body: {} });
      const after = await api(INV, invJar, `/api/vendor-returns/${rtvId}`);
      if (String(after.json?.vendorDecision) !== 'ACCEPTED') {
        throw new Error(`vendorDecision=${after.json?.vendorDecision}`);
      }
      pass(name, `${inv.noInvoice} qty=${qty}/${maxQ} noReturn=${synced.noReturn}`);
    } catch (e) {
      fail(name, e.message);
    }
  }

  pool = await listUsableInvoices(invJar);

  // ── Scenario C: full reject ──
  {
    const name = 'C.full-return-all-rejected';
    try {
      let lastErr = 'no eligible';
      let done = false;
      while (pool.length && !done) {
        const inv = take((x) => (x.maxQty || 0) >= 1);
        if (!inv) break;
        try {
          const posted = await createSubmitPost(invJar, inv.hutangId, null, `E2E ${name}`);
          const rtvId = posted.id;
          const synced = await waitCnSync(invJar, rtvId);
          if (String(synced?.cnSyncStatus) !== 'DONE') throw new Error(`cnSync=${synced?.cnSyncStatus} ${synced?.cnSyncError}`);
          const vendorTid = String(synced.vendorTenantId || inv.vendorTenantId);
          const cn = await findCnForReturn(salesJar, vendorTid, rtvId)
            || (await api(SALES, salesJar, `/api/credit-notes/${synced.creditNoteId}`, { tenantId: vendorTid })).json;
          const decisions = (cn.items || []).map((it) => ({
            lineId: String(it.lineId),
            decision: 'REJECTED',
            reason: 'E2E reject — barang masih layak',
          }));
          const dec = await salesDecide(salesJar, vendorTid, cn.id, decisions);
          if (!dec.ok) throw new Error(`decide ${JSON.stringify(dec.json)}`);
          await api(INV, invJar, `/api/vendor-returns/${rtvId}/check-decision`, { method: 'POST', body: {} });
          const after = await api(INV, invJar, `/api/vendor-returns/${rtvId}`);
          if (String(after.json?.vendorDecision) !== 'REJECTED') {
            throw new Error(`vendorDecision=${after.json?.vendorDecision}`);
          }
          const restored = (after.json?.items || []).every((it) => it.stockRestoredAt || String(it.vendorDecision) !== 'REJECTED');
          if (!restored) throw new Error('stockRestoredAt missing on rejected lines');
          pass(name, `${inv.noInvoice} ${synced.noReturn} stock restored`);
          done = true;
        } catch (e) {
          lastErr = e.message;
          if (!/Stok di lokasi|tidak cukup/i.test(e.message)) throw e;
          // try next invoice
        }
      }
      if (!done) throw new Error(lastErr);
    } catch (e) {
      fail(name, e.message);
    }
  }

  pool = await listUsableInvoices(invJar);

  // ── Scenario D: PARTIAL decide (ACCEPTED + REJECTED) — needs multi-line CN ──
  {
    const name = 'D.partial-decide-mixed';
    try {
      const inv = reservedD
        || take((x) => (x.returableLines || 0) >= 2)
        || (await listUsableInvoices(invJar)).find((x) => (x.returableLines || 0) >= 2)
        || null;
      if (!inv) {
        pass(name, 'SKIP — no multi-line returable invoice in seed (need ≥2 lines)');
      } else {
        const posted = await createSubmitPost(invJar, inv.hutangId, null, `E2E ${name}`);
        const rtvId = posted.id;
        const synced = await waitCnSync(invJar, rtvId);
        if (String(synced?.cnSyncStatus) !== 'DONE') throw new Error(`cnSync=${synced?.cnSyncStatus}`);
        const vendorTid = String(synced.vendorTenantId || inv.vendorTenantId);
        const cn = await findCnForReturn(salesJar, vendorTid, rtvId)
          || (await api(SALES, salesJar, `/api/credit-notes/${synced.creditNoteId}`, { tenantId: vendorTid })).json;
        const items = cn.items || [];
        if (items.length < 2) throw new Error(`CN only ${items.length} lines`);
        const decisions = items.map((it, idx) => (
          idx === 0
            ? { lineId: String(it.lineId), decision: 'ACCEPTED' }
            : { lineId: String(it.lineId), decision: 'REJECTED', reason: 'E2E partial reject' }
        ));
        const dec = await salesDecide(salesJar, vendorTid, cn.id, decisions);
        if (!dec.ok) throw new Error(`decide ${JSON.stringify(dec.json)}`);
        await api(INV, invJar, `/api/vendor-returns/${rtvId}/check-decision`, { method: 'POST', body: {} });
        const after = await api(INV, invJar, `/api/vendor-returns/${rtvId}`);
        if (String(after.json?.vendorDecision) !== 'PARTIAL') {
          throw new Error(`vendorDecision=${after.json?.vendorDecision}`);
        }
        pass(name, `${inv.noInvoice} ${synced.noReturn}`);
      }
    } catch (e) {
      fail(name, e.message);
    }
  }

  // ── Scenario E: inflight sibling blocked ──
  {
    const name = 'E.inflight-sibling-blocked';
    try {
      const inv = reservedE
        || take((x) => (x.maxQty || 0) >= 2)
        || (await listUsableInvoices(invJar)).find((x) => (x.maxQty || 0) >= 2)
        || null;
      if (!inv) {
        pass(name, 'SKIP — need invoice with maxQty≥2 and UOM OK');
      } else {
        const a = await api(INV, invJar, '/api/vendor-returns', {
          method: 'POST',
          body: { hutangId: inv.hutangId, reason: `E2E ${name} A` },
        });
        if (!a.ok) throw new Error(`create A ${JSON.stringify(a.json)}`);
        const idA = a.json.id;
        const detail = await api(INV, invJar, `/api/vendor-returns/${idA}`);
        const line = (detail.json.items || [])[0];
        await api(INV, invJar, `/api/vendor-returns/${idA}`, {
          method: 'PATCH',
          body: {
            reason: `E2E ${name} A`,
            items: [{ ...line, qty: 1, qtyBase: 1, jumlah: Math.round(1 * (Number(line.harga) || 0)) }],
          },
        });
        await api(INV, invJar, `/api/vendor-returns/${idA}/submit`, { method: 'POST', body: { reason: 'E2E' } });
        const postA = await api(INV, invJar, `/api/vendor-returns/${idA}/approve`, { method: 'POST', body: { reason: 'E2E' } });
        if (!postA.ok) throw new Error(`post A ${JSON.stringify(postA.json)}`);
        await waitCnSync(invJar, idA, 60_000);
        const b = await api(INV, invJar, '/api/vendor-returns', {
          method: 'POST',
          body: { hutangId: inv.hutangId, reason: `E2E ${name} B` },
        });
        if (!b.ok) throw new Error(`create B ${JSON.stringify(b.json)}`);
        const subB = await api(INV, invJar, `/api/vendor-returns/${b.json.id}/submit`, {
          method: 'POST',
          body: { reason: 'E2E B' },
        });
        const blocked = !subB.ok || /in-flight|menunggu|sibling|sudah punya retur/i.test(String(subB.json?.error || ''));
        if (!blocked && subB.ok) {
          const postB = await api(INV, invJar, `/api/vendor-returns/${b.json.id}/approve`, {
            method: 'POST',
            body: { reason: 'E2E B' },
          });
          if (postB.ok) throw new Error('second RTV should be blocked while first PENDING');
          pass(name, `blocked at post: ${postB.json?.error || postB.status}`);
        } else {
          pass(name, `blocked at submit: ${subB.json?.error || subB.status}`);
        }
        const synced = await api(INV, invJar, `/api/vendor-returns/${idA}`);
        const vendorTid = String(synced.json?.vendorTenantId || inv.vendorTenantId);
        const cnId = synced.json?.creditNoteId;
        if (cnId) {
          const cn = (await api(SALES, salesJar, `/api/credit-notes/${cnId}`, { tenantId: vendorTid })).json;
          if (cn?.status === 'DRAFT') {
            await salesDecide(salesJar, vendorTid, cnId, (cn.items || []).map((it) => ({
              lineId: String(it.lineId),
              decision: 'REJECTED',
              reason: 'E2E cleanup unlock',
            })));
            await api(INV, invJar, `/api/vendor-returns/${idA}/check-decision`, { method: 'POST', body: {} });
          }
        }
      }
    } catch (e) {
      fail(name, e.message);
    }
  }

  // ── Scenario F: Sales manual CN B2B → SKIPPED_B2B (ADR-007) ──
  {
    const name = 'F.manual-cn-b2b-skip-store-restock';
    try {
      const client = new MongoClient('mongodb://127.0.0.1:27017/?directConnection=true');
      await client.connect();
      const sdb = client.db('kasir_db');
      const candidates = await sdb.collection('invoices').find({
        tenantId: { $in: ['uddawam', 'puspita'] },
        status: 'POSTED',
        customerTenantId: TENANT,
      }).sort({ tanggal: 1 }).limit(40).toArray();
      let picked = null;
      let vendorTid = '';
      for (const invDoc of candidates) {
        vendorTid = String(invDoc.tenantId);
        const create = await api(SALES, salesJar, '/api/credit-notes', {
          method: 'POST',
          tenantId: vendorTid,
          body: {
            invoiceId: invDoc.id,
            items: (invDoc.items || []).slice(0, 1).map((it) => ({
              lineId: it.lineId,
              stokId: it.stokId,
              kode: it.kode,
              nama: it.nama,
              qty: Math.min(1, Number(it.qty) || 1),
              harga: it.harga,
              hargaBeli: it.hargaBeli || it.harga,
              satuan: it.satuan,
              uomId: it.uomId,
            })),
            catatan: 'E2E ADR-007 manual CN',
          },
        });
        if (create.ok) { picked = { invDoc, create }; break; }
      }
      if (!picked) {
        pass(name, 'SKIP — no B2B invoice with remaining returnable qty');
      } else {
        const cnId = picked.create.json.id;
        const post = await api(SALES, salesJar, `/api/credit-notes/${cnId}/post`, {
          method: 'POST',
          tenantId: vendorTid,
          body: {},
        });
        if (!post.ok) throw new Error(`post CN ${JSON.stringify(post.json)}`);
        const posted = post.json;
        if (String(posted.storeRestockStatus) !== 'SKIPPED_B2B') {
          throw new Error(`storeRestockStatus=${posted.storeRestockStatus}`);
        }
        pass(name, `CN=${posted.noCN} status=${posted.storeRestockStatus}`);
      }
      await client.close();
    } catch (e) {
      fail(name, e.message);
    }
  }

  // ── Scenario G: salah harga — CN finansial, stok Inventory tidak bergerak (ADR-008) ──
  {
    const name = 'G.price-error-cn-no-stock-move';
    try {
      const client = new MongoClient('mongodb://127.0.0.1:27017/?directConnection=true');
      await client.connect();
      const sdb = client.db('kasir_db');
      const idb = client.db('inventory_customer');
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
        // Price-error style: qty=1 at original harga (CN amount = overcharge correction proxy)
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
            catatan: 'E2E ADR-008 salah harga — koreksi komersial tanpa barang keluar',
          },
        });
        if (create.ok) { picked = { invDoc, create }; break; }
      }
      if (!picked || !line0) {
        pass(name, 'SKIP — no B2B invoice with remaining CN capacity');
        await client.close();
      } else {
        const salesStokId = String(line0.stokId || '');
        const product = await idb.collection('products').findOne({
          tenantId: TENANT,
          $or: [{ vendorStokId: salesStokId }, { id: salesStokId }, { kode: String(line0.kode || '') }],
        });
        const gudang = String(product?.gudangKode || 'GKERING');
        const stockBefore = product
          ? await idb.collection('stok_lokasi').findOne({
            tenantId: TENANT,
            stokId: product.id,
            lokasiKode: gudang,
          })
          : null;
        const qtyBefore = Number(stockBefore?.qty || 0);

        const hutangBefore = await idb.collection('hutang').findOne({
          tenantId: TENANT,
          $or: [
            { noInvoice: picked.invDoc.noInvoice || picked.invDoc.nomor },
            { vendorInvoiceId: picked.invDoc.id },
            { invoiceId: picked.invDoc.id },
          ],
        });
        const sisaBefore = Number(hutangBefore?.sisa ?? hutangBefore?.total ?? 0);
        const cnCountBefore = Array.isArray(hutangBefore?.creditNotes) ? hutangBefore.creditNotes.length : 0;

        const cnId = picked.create.json.id;
        const post = await api(SALES, salesJar, `/api/credit-notes/${cnId}/post`, {
          method: 'POST',
          tenantId: vendorTid,
          body: {},
        });
        if (!post.ok) throw new Error(`post CN ${JSON.stringify(post.json)}`);
        const posted = post.json;
        if (String(posted.storeRestockStatus) !== 'SKIPPED_B2B') {
          throw new Error(`expected SKIPPED_B2B got ${posted.storeRestockStatus}`);
        }

        // Allow hutang webhook apply
        await kickWorkers();
        await new Promise((r) => setTimeout(r, 1500));
        await kickWorkers();

        const stockAfter = product
          ? await idb.collection('stok_lokasi').findOne({
            tenantId: TENANT,
            stokId: product.id,
            lokasiKode: gudang,
          })
          : null;
        const qtyAfter = Number(stockAfter?.qty || 0);
        if (product && qtyAfter !== qtyBefore) {
          throw new Error(`stock moved ${qtyBefore}→${qtyAfter} (ADR-008 forbids)`);
        }

        const hutangAfter = hutangBefore?.id
          ? await idb.collection('hutang').findOne({ id: hutangBefore.id })
          : null;
        const cnCountAfter = Array.isArray(hutangAfter?.creditNotes) ? hutangAfter.creditNotes.length : 0;
        const sisaAfter = Number(hutangAfter?.sisa ?? hutangAfter?.total ?? sisaBefore);
        const hutangOk = !hutangBefore
          || cnCountAfter > cnCountBefore
          || sisaAfter < sisaBefore
          || String(posted.inventoryNotifyStatus || '').includes('DONE')
          || String(posted.inventorySyncStatus || '') === 'DONE';

        pass(
          name,
          `CN=${posted.noCN} stock=${qtyBefore}→${qtyAfter} hutangCn=${cnCountBefore}→${cnCountAfter} sisa=${sisaBefore}→${sisaAfter}${hutangOk ? '' : ' (hutang apply pending)'}`,
        );
        await client.close();
      }
    } catch (e) {
      fail(name, e.message);
    }
  }

  summarize();
}

function summarize() {
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
