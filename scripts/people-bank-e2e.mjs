#!/usr/bin/env node
/**
 * E2E API Sprint 2 — impor mutasi BNI + match/ignore + idempoten bankRef.
 *   APP_URL=http://127.0.0.1:3001 node scripts/people-bank-e2e.mjs
 */
const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const EMAIL = process.env.E2E_EMAIL || process.env.E2E_MASTER_EMAIL || 'dawam@master.com';
const PASSWORD = process.env.E2E_PASSWORD || process.env.E2E_MASTER_PASSWORD || 'dawam123';
const TENANT = process.env.E2E_TENANT || 'sppg';
const SESSION_COOKIE = 'inventory_session';

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

async function createPerson(headers, payload) {
  return fetchJson('/api/people', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

async function main() {
  console.log(`\n=== Personel Sprint 2 E2E (BNI mutasi) ===\nAPP=${APP_URL}\nTENANT=${TENANT}\n`);

  const cookie = await login();
  if (!cookie) {
    console.log('\nABORT: login gagal\n');
    process.exit(1);
  }
  const headers = authHeaders(cookie);
  const stamp = Date.now().toString().slice(-10);
  const norek = `11${stamp}`.slice(0, 12);
  const ntbInhouse = `NTB${stamp}IN`;
  const ntbBifast = `NTB${stamp}BF`;
  const ntbIgnore = `NTB${stamp}IG`;
  const ntbKredit = `NTB${stamp}CR`;

  const siti = await createPerson(headers, {
    nama: `[E2E-BNI] Siti ${stamp}`,
    jenis: 'KARYAWAN',
    peran: 'JURU_MASAK',
    nik: `siti-${stamp}`,
    bankAccounts: [{
      bankCode: 'BNI',
      accountNo: norek,
      accountName: `Siti ${stamp}`,
      isPrimary: true,
    }],
    aktif: true,
  });
  const sitiId = siti.body?.id;
  record('people:create-siti', Boolean(siti.res.ok && sitiId && siti.body?.kode), siti.res.ok ? siti.body.kode : `${siti.res.status} ${siti.body?.error || ''}`);

  const budi = await createPerson(headers, {
    nama: `[E2E-BNI] Budi ${stamp}`,
    jenis: 'KARYAWAN',
    peran: 'ASISTEN',
    nik: `budi-${stamp}`,
    bankAccounts: [{
      bankCode: 'BCA',
      accountNo: `22${stamp}`.slice(0, 12),
      accountName: `Budi ${stamp}`,
      isPrimary: true,
    }],
    aktif: true,
  });
  const budiId = budi.body?.id;
  record('people:create-budi', Boolean(budi.res.ok && budiId), budi.res.ok ? budi.body.kode : `${budi.res.status} ${budi.body?.error || ''}`);

  const csv = [
    'Tanggal;Keterangan;Debet;Kredit;Saldo;NTB',
    `05/03/2029;TRANSFER INHOUSE BNI ${norek} AN. SITI AMINAH;1.500.000;0;98.500.000;${ntbInhouse}`,
    `05/03/2029;BI FAST KE BUDI SANTOSO;750.000;0;97.750.000;${ntbBifast}`,
    `05/03/2029;KREDIT BUNGA;0;25.000;97.775.000;${ntbKredit}`,
  ].join('\n');

  const imported = await fetchJson('/api/bank-txn/import', {
    method: 'POST',
    headers,
    body: JSON.stringify({ csvText: csv }),
  });
  const imp = imported.body || {};
  record(
    'bank:import',
    imported.res.ok && imp.inserted === 2 && imp.matched === 1 && imp.unmatchedCount === 1 && imp.duplicate === 0,
    imported.res.ok
      ? `inserted=${imp.inserted} matched=${imp.matched} unmatched=${imp.unmatchedCount} dup=${imp.duplicate}`
      : `${imported.res.status} ${imp.error || ''}`,
  );
  if (sitiId) {
    const sitiDetail = await fetchJson(`/api/people/${sitiId}`, { headers });
    record(
      'bank:auto-match-payment-count',
      sitiDetail.res.ok
        && Number(sitiDetail.body?.paymentCount) === 1
        && Number(sitiDetail.body?.lastPaidAmount) === 1_500_000
        && String(sitiDetail.body?.lastPaidAt || '').startsWith('2029-03-05'),
      `paymentCount=${sitiDetail.body?.paymentCount} last=${sitiDetail.body?.lastPaidAt} amt=${sitiDetail.body?.lastPaidAmount}`,
    );

    const hist = await fetchJson(`/api/people/${sitiId}/payments`, { headers });
    const first = hist.body?.items?.[0];
    record(
      'pay:history',
      hist.res.ok
        && first?.accountNo === norek
        && first?.amount === 1_500_000
        && first?.bankRef === ntbInhouse
        && first?.tanggal === '2029-03-05'
        && first?.status === 'POSTED'
        && Number(hist.body?.total) === 1
        && Number(hist.body?.totalAmount) === 1_500_000
        && hist.body?.hasMore === false,
      hist.res.ok ? `${first?.noDokumen} ${first?.accountNo}` : `${hist.res.status} ${hist.body?.error || ''}`,
    );

    const newNorek = `33${stamp}`.slice(0, 12);
    const putBank = await fetchJson(`/api/people/${sitiId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        bankAccounts: [{
          bankCode: 'BCA',
          accountNo: newNorek,
          accountName: `Siti ${stamp}`,
          isPrimary: true,
        }],
      }),
    });
    record(
      'pay:master-bank-changed',
      putBank.res.ok && putBank.body?.bankAccounts?.[0]?.accountNo === newNorek,
      putBank.body?.bankAccounts?.[0]?.accountNo || putBank.body?.error || '',
    );

    const histAfter = await fetchJson(`/api/people/${sitiId}/payments`, { headers });
    record(
      'pay:snapshot-norek',
      histAfter.res.ok
        && histAfter.body?.items?.[0]?.accountNo === norek
        && histAfter.body?.items?.[0]?.bankCode === 'BNI',
      `history=${histAfter.body?.items?.[0]?.accountNo}/${histAfter.body?.items?.[0]?.bankCode} master=${newNorek}`,
    );

    const ranged = await fetchJson(
      `/api/kitchen-people/${sitiId}/payments?from=2029-03-01&to=2029-03-31`,
      { headers },
    );
    record(
      'pay:alias-range',
      ranged.res.ok && ranged.body?.items?.length === 1 && Number(ranged.body?.totalAmount) === 1_500_000,
      `n=${ranged.body?.items?.length} total=${ranged.body?.totalAmount}`,
    );

    const emptyRange = await fetchJson(
      `/api/people/${sitiId}/payments?from=2020-01-01&to=2020-01-31`,
      { headers },
    );
    record(
      'pay:range-empty',
      emptyRange.res.ok && emptyRange.body?.items?.length === 0 && Number(emptyRange.body?.totalAmount || 0) === 0,
      `n=${emptyRange.body?.items?.length}`,
    );

    const badFrom = await fetchJson(`/api/people/${sitiId}/payments?from=05-03-2029`, { headers });
    record('pay:from-invalid', badFrom.res.status === 400, `${badFrom.res.status} ${badFrom.body?.error || ''}`);

    const inverted = await fetchJson(
      `/api/people/${sitiId}/payments?from=2029-04-01&to=2029-03-01`,
      { headers },
    );
    record('pay:from-after-to', inverted.res.status === 400, `${inverted.res.status} ${inverted.body?.error || ''}`);

    const postedOnly = await fetchJson(`/api/people/${sitiId}/payments?status=POSTED`, { headers });
    record(
      'pay:status-posted',
      postedOnly.res.ok && postedOnly.body?.items?.length === 1 && postedOnly.body?.items?.[0]?.status === 'POSTED',
      `n=${postedOnly.body?.items?.length}`,
    );

    const missing = await fetchJson('/api/people/does-not-exist/payments', { headers });
    record('pay:missing-person', missing.res.status === 404, `${missing.res.status}`);
  }

  const replay = await fetchJson('/api/bank-txn/import', {
    method: 'POST',
    headers,
    body: JSON.stringify({ csvText: csv }),
  });
  const rp = replay.body || {};
  record(
    'bank:import-idempotent',
    replay.res.ok && rp.inserted === 0 && rp.duplicate === 2 && rp.matched === 0,
    `inserted=${rp.inserted} dup=${rp.duplicate} matched=${rp.matched}`,
  );
  if (sitiId) {
    const afterDup = await fetchJson(`/api/people/${sitiId}/payments`, { headers });
    const detailDup = await fetchJson(`/api/people/${sitiId}`, { headers });
    record(
      'pay:no-double-pay',
      afterDup.res.ok && afterDup.body?.items?.length === 1 && Number(detailDup.body?.paymentCount) === 1,
      `items=${afterDup.body?.items?.length} paymentCount=${detailDup.body?.paymentCount}`,
    );
  }

  const queue = await fetchJson('/api/bank-txn?status=NEW', { headers });
  const unmatched = Array.isArray(queue.body) ? queue.body.filter((r) => r.bankRef === ntbBifast) : [];
  record('bank:queue-new', queue.res.ok && unmatched.length === 1, `n=${Array.isArray(queue.body) ? queue.body.length : 0}`);

  const unmatchedId = unmatched[0]?.id;
  if (unmatchedId && budiId) {
    const matched = await fetchJson(`/api/bank-txn/${unmatchedId}/match`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ personId: budiId }),
    });
    record(
      'bank:manual-match',
      matched.res.ok && Boolean(matched.body?.paymentId || matched.body?.alreadyMatched),
      matched.res.ok ? (matched.body?.noDokumen || matched.body?.paymentId) : `${matched.res.status} ${matched.body?.error || ''}`,
    );
    const detail = await fetchJson(`/api/people/${budiId}`, { headers });
    record(
      'bank:payment-posted-on-person',
      detail.res.ok && Number(detail.body?.paymentCount || 0) >= 1 && Number(detail.body?.lastPaidAmount || 0) === 750000,
      `paymentCount=${detail.body?.paymentCount} last=${detail.body?.lastPaidAmount}`,
    );
  } else {
    record('bank:manual-match', false, 'no unmatched id');
  }

  const csvIgnore = [
    'Tanggal;Keterangan;Debet;Kredit;Saldo;NTB',
    `05/03/2029;TRANSFER UNKNOWN 9999999999;100.000;0;0;${ntbIgnore}`,
  ].join('\n');
  const importedIgnore = await fetchJson('/api/bank-txn/import', {
    method: 'POST',
    headers,
    body: JSON.stringify({ csvText: csvIgnore }),
  });
  const ignoreRow = (importedIgnore.body?.unmatched || []).find((r) => r.bankRef === ntbIgnore)
    || (Array.isArray((await fetchJson('/api/bank-txn?status=NEW', { headers })).body)
      ? (await fetchJson('/api/bank-txn?status=NEW', { headers })).body.find((r) => r.bankRef === ntbIgnore)
      : null);
  record('bank:import-ignore-row', Boolean(importedIgnore.res.ok && ignoreRow?.id), ignoreRow?.id || importedIgnore.body?.error || '');

  if (ignoreRow?.id) {
    const ignored = await fetchJson(`/api/bank-txn/${ignoreRow.id}/ignore`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    record('bank:ignore', ignored.res.ok && ignored.body?.status === 'IGNORED', ignored.body?.status || ignored.body?.error || '');
  } else {
    record('bank:ignore', false, 'no ignore row');
  }

  const after = await fetchJson('/api/bank-txn?status=NEW', { headers });
  const leftover = Array.isArray(after.body)
    ? after.body.filter((r) => [ntbInhouse, ntbBifast, ntbIgnore].includes(r.bankRef))
    : [];
  record('bank:queue-cleared', after.res.ok && leftover.length === 0, `leftover=${leftover.length}`);

  if (sitiId) {
    await fetchJson(`/api/people/${sitiId}`, { method: 'DELETE', headers });
  }
  if (budiId) {
    await fetchJson(`/api/people/${budiId}`, { method: 'DELETE', headers });
  }

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
