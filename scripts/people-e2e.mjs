#!/usr/bin/env node
/**
 * E2E API Sprint 1 — master Personel.
 *   APP_URL=http://127.0.0.1:3001 node scripts/people-e2e.mjs
 */
const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const EMAIL = process.env.E2E_EMAIL || process.env.E2E_MASTER_EMAIL || 'dawam@master.com';
const PASSWORD = process.env.E2E_PASSWORD || process.env.E2E_MASTER_PASSWORD || 'dawam123';
const TENANT = process.env.E2E_TENANT || 'sppg';
const SESSION_COOKIE = 'inventory_session';
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function fetchJson(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${APP_URL}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeout ?? 45_000), ...opts });
  const ct = res.headers.get('content-type') || '';
  let body = null;
  if (ct.includes('json')) {
    try { body = await res.json(); } catch { body = null; }
  } else {
    try { body = await res.arrayBuffer(); } catch { body = null; }
  }
  return { res, body };
}

function cookiePair(setCookieList, name) {
  const raw = (setCookieList || []).find((c) => c.startsWith(`${name}=`));
  return raw ? raw.split(';')[0] : null;
}

async function login() {
  const first = await fetchJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  let body = first.body;
  let set = first.res.headers.getSetCookie?.() || [];
  if (body?.needsTenantPick) {
    const tenants = body.tenants || [];
    const pick = tenants.find((t) => t.id === TENANT || t.tenantId === TENANT)
      || tenants.find((t) => /sppg/i.test(`${t.id} ${t.tenantId} ${t.name}`))
      || tenants[0];
    const tenantId = pick?.id || pick?.tenantId || TENANT;
    const second = await fetchJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, tenantId }),
    });
    body = second.body;
    set = second.res.headers.getSetCookie?.() || [];
  }
  const session = cookiePair(set, SESSION_COOKIE);
  record('auth:login', Boolean(session && body?.user), session ? `user=${body?.user?.email}` : String(body?.error || 'no cookie'));
  if (!session) return null;

  const acting = await fetchJson('/api/tenant/acting', {
    method: 'POST',
    headers: { Cookie: session, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId: TENANT }),
  });
  const actingSet = acting.res.headers.getSetCookie?.() || [];
  const actingCookie = cookiePair(actingSet, 'erp_acting_tenant_id') || `erp_acting_tenant_id=${TENANT}`;
  record('auth:acting-tenant', acting.res.ok, acting.body?.tenantId || acting.body?.error || TENANT);
  return acting.res.ok ? `${session}; ${actingCookie}` : session;
}

function authHeaders(cookie) {
  return { Cookie: cookie, 'Content-Type': 'application/json' };
}

async function main() {
  console.log(`\n=== Personel Sprint 1 E2E ===\nAPP=${APP_URL}\nTENANT=${TENANT}\n`);

  const health = await fetchJson('/api/health');
  record('health:database', health.res.ok && health.body?.checks?.database === 'ok', `status=${health.body?.status}`);

  const cookie = await login();
  if (!cookie) {
    console.log('\nABORT: login gagal\n');
    process.exit(1);
  }
  const headers = authHeaders(cookie);

  const stamp = Date.now().toString().slice(-10);
  const nama = `[E2E-PEOPLE] Siti ${stamp}`;
  const nik = `3201${stamp.padStart(12, '0').slice(-12)}`;
  const accountNo = `88${stamp}`.slice(0, 16);

  const kitchens = await fetchJson('/api/kitchens?aktif=1', { headers });
  const kitchenId = Array.isArray(kitchens.body) ? kitchens.body[0]?.id : null;
  record('kitchens:list', kitchens.res.ok, kitchenId ? `kitchen=${kitchenId}` : 'none');

  const created = await fetchJson('/api/people', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      nama,
      jenis: 'KARYAWAN',
      peran: 'JURU_MASAK',
      jabatan: 'Juru masak e2e',
      nik,
      noTelp: '081234567890',
      kitchenIds: kitchenId ? [kitchenId] : [],
      bankAccounts: [{
        bankCode: 'BCA',
        accountNo,
        accountName: nama,
        isPrimary: true,
      }],
      aktif: true,
    }),
  });
  const doc = created.body || {};
  const personId = doc.id;
  record(
    'people:create',
    created.res.ok && /^KDP\d+$/.test(String(doc.kode || '')) && doc.nama === nama,
    created.res.ok ? `${doc.kode} ${personId}` : `${created.res.status} ${doc.error || ''}`,
  );
  record('people:create-no-filename', !JSON.stringify(doc).includes('filename'), '');

  if (!personId) {
    failSummary();
    process.exit(1);
  }

  const list = await fetchJson('/api/people?aktif=1', { headers });
  const rows = Array.isArray(list.body) ? list.body : [];
  const row = rows.find((r) => r.id === personId);
  record('people:list', list.res.ok && Boolean(row), `n=${rows.length}`);
  record('people:list-no-attachments', row && !Object.prototype.hasOwnProperty.call(row, 'attachments'), '');
  record('people:list-no-filename', !JSON.stringify(rows).includes('filename'), '');

  const alias = await fetchJson(`/api/kitchen-people?q=${encodeURIComponent(nama)}`, { headers });
  const aliasRows = Array.isArray(alias.body) ? alias.body : [];
  record('people:alias-kitchen-people', alias.res.ok && aliasRows.some((r) => r.id === personId), `n=${aliasRows.length}`);

  const pay = await fetchJson(`/api/people/${personId}/payments`, { headers });
  record(
    'people:payments-empty',
    pay.res.ok
      && Array.isArray(pay.body?.items)
      && pay.body.items.length === 0
      && Number(pay.body?.total || 0) === 0
      && Number(pay.body?.totalAmount || 0) === 0
      && pay.body?.hasMore === false,
    JSON.stringify(pay.body),
  );

  const att = await fetchJson(`/api/people/${personId}/attachments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'FOTO',
      title: 'Pasfoto e2e',
      originalName: 'pasfoto.png',
      dataBase64: PNG_1X1,
    }),
  });
  const attachments = att.body?.attachments || [];
  const foto = attachments.find((a) => a.kind === 'FOTO');
  record(
    'people:attachment-add',
    att.res.ok && Boolean(foto?.id) && !JSON.stringify(att.body).includes('filename'),
    att.res.ok ? `id=${foto?.id}` : `${att.res.status} ${att.body?.error || ''}`,
  );

  if (foto?.id) {
    const dl = await fetch(`${APP_URL}/api/people/${personId}/attachments/${foto.id}`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(45_000),
    });
    const cache = dl.headers.get('cache-control') || '';
    const ct = dl.headers.get('content-type') || '';
    const buf = Buffer.from(await dl.arrayBuffer());
    record(
      'people:attachment-download',
      dl.ok && /image\//.test(ct) && /private/i.test(cache) && buf.length > 10,
      `status=${dl.status} ct=${ct} bytes=${buf.length} cache=${cache}`,
    );
  } else {
    record('people:attachment-download', false, 'no attachment id');
  }

  const detail = await fetchJson(`/api/people/${personId}`, { headers });
  record(
    'people:detail',
    detail.res.ok && detail.body?.id === personId && Number(detail.body?.paymentCount || 0) === 0,
    `paymentCount=${detail.body?.paymentCount}`,
  );
  record('people:detail-no-filename', !JSON.stringify(detail.body || {}).includes('filename'), '');

  const media = await fetchJson(`/api/media/${TENANT}/kdp-not-a-real-file.png`, { headers: { Cookie: cookie } });
  record('media:hr-prefix-blocked', media.res.status === 404, `status=${media.res.status}`);

  const deactivate = await fetchJson(`/api/people/${personId}`, { method: 'DELETE', headers });
  record('people:deactivate', deactivate.res.ok && deactivate.body?.aktif === false, JSON.stringify(deactivate.body));

  const inactiveList = await fetchJson('/api/people?aktif=1', { headers });
  const stillActive = Array.isArray(inactiveList.body) && inactiveList.body.some((r) => r.id === personId);
  record('people:aktif-filter', inactiveList.res.ok && !stillActive, stillActive ? 'masih di aktif=1' : 'tersaring');

  failSummary();
}

function failSummary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} pass`);
  if (failed.length) {
    console.log('Failed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
