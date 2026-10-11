#!/usr/bin/env node
/**
 * E2E API PB/PK split per resep (kategori menu multi-resep) — minggu terisolasi 2029-04-02.
 *
 *   APP_URL=http://127.0.0.1:3001 node scripts/menu-slot-porsi-family-e2e.mjs
 */
const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const EMAIL = process.env.E2E_EMAIL || process.env.E2E_MASTER_EMAIL || 'dawam@master.com';
const PASSWORD = process.env.E2E_PASSWORD || process.env.E2E_MASTER_PASSWORD || 'dawam123';
const TENANT = process.env.E2E_TENANT || 'sppg';
const SESSION_COOKIE = 'inventory_session';
const WEEK_START = '2029-04-02';
const DAY = '2029-04-04';
const PREFERRED_KITCHEN = '15f537f2-b0ef-40e2-8cc8-54cc95461f72';
const PM6 = {
  PORSI_KECIL: 400,
  PORSI_BESAR: 800,
  POSYANDU_BALITA: 50,
  POSYANDU_BUMIL: 30,
  POSYANDU_BUSUI: 20,
  ORGANOLEPTIK: 12,
};
const PB_TOTAL = 800 + 30 + 20 + 12;
const PK_TOTAL = 400 + 50;
const ALL = PB_TOTAL + PK_TOTAL;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function fetchJson(path, opts = {}) {
  const res = await fetch(`${APP_URL}${path}`, { signal: AbortSignal.timeout(90_000), ...opts });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { res, body };
}

function cookiePair(list, name) {
  const raw = list.find((c) => c.startsWith(`${name}=`));
  return raw ? raw.split(';')[0] : null;
}

async function login() {
  let r = await fetchJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (r.body?.needsTenantPick) {
    r = await fetchJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, tenantId: TENANT }),
    });
  }
  const session = cookiePair(r.res.headers.getSetCookie?.() || [], SESSION_COOKIE);
  record('auth:login', Boolean(session), session ? EMAIL : String(r.body?.error));
  if (!session) return null;
  const acting = await fetchJson('/api/tenant/acting', {
    method: 'POST',
    headers: { Cookie: session, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId: TENANT }),
  });
  const actingCookie = cookiePair(acting.res.headers.getSetCookie?.() || [], 'erp_acting_tenant_id')
    || `erp_acting_tenant_id=${TENANT}`;
  return `${session}; ${actingCookie}`;
}

async function main() {
  console.log(`\n=== PB/PK split E2E ===\nAPP=${APP_URL}\nDAY=${DAY}\n`);
  const cookie = await login();
  if (!cookie) process.exit(1);
  const h = { Cookie: cookie, 'Content-Type': 'application/json' };

  const kitchens = (await fetchJson('/api/kitchens?aktif=1', { headers: h })).body || [];
  const kitchenId = (kitchens.find((k) => k.id === PREFERRED_KITCHEN) || kitchens[0])?.id;
  const recipes = ((await fetchJson('/api/recipes?aktif=1', { headers: h })).body || [])
    .filter((r) => r.aktif !== false && r.kategoriMenu && Array.isArray(r.lines) && r.lines.length);
  const bySlot = new Map();
  for (const r of recipes) bySlot.set(r.kategoriMenu, [...(bySlot.get(r.kategoriMenu) || []), r]);
  const pair = [...bySlot.entries()].find(([, list]) => list.length >= 2);
  record('fixture:2 resep satu kategori', Boolean(kitchenId && pair), pair ? `${pair[0]}: ${pair[1].map((r) => r.kode).join(', ')}` : 'tidak ada');
  if (!pair) process.exit(1);
  const [slot, [a, b]] = pair;
  const filler = recipes.find((r) => r.kategoriMenu !== slot);

  const dayPayload = (families) => ({
    tanggal: DAY,
    porsiByKategori: { ...PM6 },
    slots: { [slot]: [a.id, b.id], ...(filler ? { [filler.kategoriMenu]: [filler.id] } : {}) },
    ...(families !== undefined ? { recipePorsiFamilies: families } : {}),
    alergi: [],
  });
  const put = (families) => fetchJson('/api/weekly-menu-plans', {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({ kitchenId, weekStart: WEEK_START, days: [dayPayload(families)] }),
  });
  const dayOf = (doc) => (doc?.days || []).find((d) => d.tanggal === DAY);

  const prevWeek = (await fetchJson(
    `/api/weekly-menu-plans?kitchenId=${encodeURIComponent(kitchenId)}&weekStart=${WEEK_START}`, { headers: h },
  )).body;
  const prevPlanId = dayOf(prevWeek)?.productionPlanId;
  if (prevPlanId) {
    const prevPlans = (await fetchJson(`/api/production-plans?tanggal=${DAY}&kitchenId=${encodeURIComponent(kitchenId)}`, { headers: h })).body || [];
    if (prevPlans.find((p) => p.id === prevPlanId)?.status === 'APPROVED') {
      await fetchJson(`/api/production-plans/${prevPlanId}/revise-menu`, {
        method: 'POST', headers: h, body: JSON.stringify({ reason: 'E2E reset minggu uji split PB/PK' }),
      });
    }
  }

  const empty = await put({ [a.id]: [] });
  record('normalize: pilihan kosong ditolak', empty.res.status === 400 && /minimal PB atau PK/.test(empty.body?.error || ''), empty.body?.error);
  const stray = await put({ [a.id]: 'BESAR' });
  record('normalize: format bukan array ditolak', stray.res.status === 400, stray.body?.error);

  const saved = await put({ [a.id]: ['BESAR'], [b.id]: ['KECIL'], ...(filler ? { [filler.id]: ['KECIL'] } : {}) });
  const fam = dayOf(saved.body)?.recipePorsiFamilies;
  record('normalize: simpan split, buang resep kategori tunggal', saved.res.ok
    && JSON.stringify(fam) === JSON.stringify({ [a.id]: ['BESAR'], [b.id]: ['KECIL'] }), JSON.stringify(fam));

  const pub = await fetchJson(`/api/weekly-menu-plans/${saved.body.id}/publish`, {
    method: 'POST', headers: h, body: JSON.stringify({ tanggal: DAY }),
  });
  const planId = pub.body?.published?.[0]?.productionPlanId;
  record('publish: RPN terbit', pub.res.ok && Boolean(planId), pub.body?.error || pub.body?.published?.[0]?.productionPlanNo);
  const plans = (await fetchJson(`/api/production-plans?tanggal=${DAY}&kitchenId=${encodeURIComponent(kitchenId)}`, { headers: h })).body || [];
  const rpn = plans.find((p) => p.id === planId);
  const lineA = rpn?.lines?.find((l) => l.recipeId === a.id);
  const lineB = rpn?.lines?.find((l) => l.recipeId === b.id);
  const lineF = filler ? rpn?.lines?.find((l) => l.recipeId === filler.id) : null;
  record('rpn: resep PB = porsi keluarga PB', lineA?.targetPorsi === PB_TOTAL && !(lineA.kategoriPorsiList || []).includes('PORSI_KECIL'),
    `${lineA?.targetPorsi} ${JSON.stringify(lineA?.kategoriPorsiList)}`);
  record('rpn: resep PK = porsi keluarga PK', lineB?.targetPorsi === PK_TOTAL
    && JSON.stringify([...(lineB.kategoriPorsiList || [])].sort()) === JSON.stringify(['PORSI_KECIL', 'POSYANDU_BALITA']),
    `${lineB?.targetPorsi} ${JSON.stringify(lineB?.kategoriPorsiList)}`);
  if (filler) record('rpn: kategori tunggal tetap total PM', lineF?.targetPorsi === ALL, String(lineF?.targetPorsi));

  await put({ [a.id]: ['BESAR'], [b.id]: ['BESAR'] });
  const gap = await fetchJson(`/api/weekly-menu-plans/${saved.body.id}/publish`, {
    method: 'POST', headers: h, body: JSON.stringify({ tanggal: DAY }),
  });
  record('coverage: PK tanpa resep → peringatan, terbit tetap jalan', gap.res.ok
    && (gap.body?.warnings || []).some((w) => w.includes(`PK (${PK_TOTAL}) tidak ada resep`))
    && gap.body?.published?.[0]?.productionPlanId === planId, JSON.stringify(gap.body?.warnings || gap.body?.error));

  const noPk = await fetchJson('/api/weekly-menu-plans', {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({
      kitchenId,
      weekStart: WEEK_START,
      days: [{ ...dayPayload({ [a.id]: ['BESAR'], [b.id]: ['KECIL'] }), porsiByKategori: { ...PM6, PORSI_KECIL: 0, POSYANDU_BALITA: 0 } }],
    }),
  });
  const skip = await fetchJson(`/api/weekly-menu-plans/${saved.body.id}/publish`, {
    method: 'POST', headers: h, body: JSON.stringify({ tanggal: DAY }),
  });
  const plans2 = (await fetchJson(`/api/production-plans?tanggal=${DAY}&kitchenId=${encodeURIComponent(kitchenId)}`, { headers: h })).body || [];
  const rpn2 = plans2.find((p) => p.id === planId);
  record('skip: resep PK saat PK = 0 tidak masuk RPN (bukan fallback total)', noPk.res.ok && skip.res.ok
    && !(rpn2?.lines || []).some((l) => l.recipeId === b.id)
    && (rpn2?.lines || []).find((l) => l.recipeId === a.id)?.targetPorsi === PB_TOTAL,
    JSON.stringify((rpn2?.lines || []).map((l) => [l.recipeKode, l.targetPorsi])));

  const reset = await put({});
  record('reset: semua tercentang → field hilang', reset.res.ok && dayOf(reset.body)?.recipePorsiFamilies === undefined);
  const republish = await fetchJson(`/api/weekly-menu-plans/${saved.body.id}/publish`, {
    method: 'POST', headers: h, body: JSON.stringify({ tanggal: DAY }),
  });
  const plans3 = (await fetchJson(`/api/production-plans?tanggal=${DAY}&kitchenId=${encodeURIComponent(kitchenId)}`, { headers: h })).body || [];
  const rpn3 = plans3.find((p) => p.id === planId);
  record('reset: terbit ulang → kedua resep kembali total PM', republish.res.ok
    && [a.id, b.id].every((id) => (rpn3?.lines || []).find((l) => l.recipeId === id)?.targetPorsi === ALL));

  const setStatus = (status) => fetchJson(`/api/production-plans/${planId}/status`, {
    method: 'POST', headers: h, body: JSON.stringify({ status }),
  });
  const sub = await setStatus('SUBMITTED');
  const appr = await setStatus('APPROVED');
  record('lock: RPN diajukan & disetujui', sub.res.ok && appr.res.ok, sub.body?.error || appr.body?.error || '');
  if (appr.res.ok) {
    const blocked = await put({ [a.id]: ['BESAR'], [b.id]: ['KECIL'] });
    record('lock: ubah PB/PK pada RPN APPROVED ditolak 409', blocked.res.status === 409, blocked.body?.error);
    const same = await put({});
    record('lock: simpan tanpa perubahan tetap boleh', same.res.ok, same.body?.error || '');

    const rev = await fetchJson(`/api/production-plans/${planId}/revise-menu`, {
      method: 'POST', headers: h, body: JSON.stringify({ reason: 'E2E revisi split PB/PK resep lauk' }),
    });
    record('revisi: buka revisi menu', rev.res.ok, rev.body?.error || rev.body?.status);
    if (rev.res.ok) {
      const edit = await put({ [a.id]: ['BESAR'], [b.id]: ['KECIL'] });
      record('revisi: ubah PB/PK setelah revisi boleh', edit.res.ok, edit.body?.error || '');
      const early = await setStatus('APPROVED');
      record('revisi: setujui tanpa terbit ulang ditolak', early.res.status === 409, early.body?.error);
      const rp = await fetchJson(`/api/weekly-menu-plans/${saved.body.id}/publish`, {
        method: 'POST', headers: h, body: JSON.stringify({ tanggal: DAY }),
      });
      const plans4 = (await fetchJson(`/api/production-plans?tanggal=${DAY}&kitchenId=${encodeURIComponent(kitchenId)}`, { headers: h })).body || [];
      const rpn4 = plans4.find((p) => p.id === planId);
      record('revisi: terbit ulang memperbarui RPN yang sama', rp.res.ok
        && rpn4?.lines?.find((l) => l.recipeId === a.id)?.targetPorsi === PB_TOTAL
        && rpn4?.lines?.find((l) => l.recipeId === b.id)?.targetPorsi === PK_TOTAL, rp.body?.error || rpn4?.status);
      const again = await setStatus('APPROVED');
      record('revisi: setujui ulang setelah terbit', again.res.ok, again.body?.error || '');
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
