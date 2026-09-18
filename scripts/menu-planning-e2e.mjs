#!/usr/bin/env node
/**
 * E2E API Perencanaan Menu — minggu terisolasi 2029-03-05.
 *
 *   APP_URL=http://127.0.0.1:3001 node scripts/menu-planning-e2e.mjs
 */
const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const EMAIL = process.env.E2E_EMAIL || process.env.E2E_MASTER_EMAIL || 'dawam@master.com';
const PASSWORD = process.env.E2E_PASSWORD || process.env.E2E_MASTER_PASSWORD || 'dawam123';
const TENANT = process.env.E2E_TENANT || 'sppg';
const SESSION_COOKIE = 'inventory_session';
const WEEK_START = '2029-03-05';
const COPY_WEEK = '2029-03-12';
const NOTE = '[E2E-MENU-PLAN] minggu uji — aman ditimpa tes berikutnya';
const PREFERRED_KITCHEN = '15f537f2-b0ef-40e2-8cc8-54cc95461f72';
const PM6 = {
  PORSI_KECIL: 40,
  PORSI_BESAR: 80,
  POSYANDU_BALITA: 10,
  POSYANDU_BUMIL: 5,
  POSYANDU_BUSUI: 4,
  ORGANOLEPTIK: 2,
};

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function emptyPm() {
  return {
    PORSI_KECIL: 0,
    PORSI_BESAR: 0,
    POSYANDU_BALITA: 0,
    POSYANDU_BUMIL: 0,
    POSYANDU_BUSUI: 0,
    ORGANOLEPTIK: 0,
  };
}

function isoOffset(start, days) {
  const [y, m, d] = start.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

async function fetchJson(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${APP_URL}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeout ?? 45_000), ...opts });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { res, body };
}

function cookiePair(setCookieList, name) {
  const raw = setCookieList.find((c) => c.startsWith(`${name}=`));
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

function usableRecipes(list) {
  return (list || []).filter((r) => (
    r.aktif !== false
    && r.id
    && r.kategoriMenu
    && Array.isArray(r.lines)
    && r.lines.length > 0
  ));
}

async function main() {
  console.log(`\n=== Perencanaan Menu E2E ===\nAPP=${APP_URL}\nWEEK=${WEEK_START}\n`);

  const health = await fetchJson('/api/health');
  record('health', health.res.ok && health.body?.checks?.database === 'ok', `status=${health.body?.status}`);

  const cookie = await login();
  if (!cookie) {
    console.log('\nLogin gagal — berhenti.');
    process.exit(1);
  }
  const h = authHeaders(cookie);

  const noKitchen = await fetchJson(`/api/weekly-menu-plans?weekStart=${WEEK_START}`, { headers: h });
  record('gate:kitchen-wajib', noKitchen.res.status === 400 && /dapur/i.test(String(noKitchen.body?.error || '')), noKitchen.body?.error);

  const tuesday = await fetchJson(`/api/weekly-menu-plans?kitchenId=${PREFERRED_KITCHEN}&weekStart=2029-03-06`, { headers: h });
  record('gate:weekStart-senin', tuesday.res.status === 400 && /senin/i.test(String(tuesday.body?.error || '')), tuesday.body?.error);

  const kitchensRes = await fetchJson('/api/kitchens?aktif=1', { headers: h });
  const kitchens = Array.isArray(kitchensRes.body) ? kitchensRes.body : [];
  const kitchen = kitchens.find((k) => k.id === PREFERRED_KITCHEN)
    || kitchens.find((k) => /DPRKPJ2|Kepanjen 2/i.test(`${k.kode} ${k.nama}`))
    || kitchens[0];
  record('fixture:kitchen', Boolean(kitchen?.id), kitchen ? `${kitchen.kode} ${kitchen.nama}` : String(kitchensRes.res.status));
  if (!kitchen?.id) {
    process.exit(1);
  }

  const recipesRes = await fetchJson('/api/recipes?aktif=1', { headers: h });
  const recipes = usableRecipes(recipesRes.body);
  record('fixture:recipes', recipes.length > 1, `usable=${recipes.length}`);
  if (recipes.length < 2) {
    process.exit(1);
  }

  const menusRes = await fetchJson('/api/menus?aktif=1', { headers: h });
  record('fixture:menus', menusRes.res.ok && Array.isArray(menusRes.body), `n=${(menusRes.body || []).length}`);

  const spRes = await fetchJson(`/api/service-points?aktif=1&kitchenId=${encodeURIComponent(kitchen.id)}`, { headers: h });
  record('fixture:service-points-kitchen', spRes.res.ok && Array.isArray(spRes.body), `n=${(spRes.body || []).length}`);

  const slotRecipe = recipes[0];
  const otherSlot = slotRecipe.kategoriMenu === 'GARNISH' ? 'KARBOHIDRAT' : 'GARNISH';
  const dup = await fetchJson('/api/weekly-menu-plans', {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({
      kitchenId: kitchen.id,
      weekStart: WEEK_START,
      days: [{
        tanggal: WEEK_START,
        porsiByKategori: { ...PM6 },
        slots: {
          [slotRecipe.kategoriMenu]: [slotRecipe.id],
          [otherSlot]: [slotRecipe.id],
        },
        alergi: [],
      }],
    }),
  });
  record('gate:resep-duplikat', dup.res.status === 400 && /dua kali|duplikat/i.test(String(dup.body?.error || '')), dup.body?.error);

  const emptyPut = await fetchJson('/api/weekly-menu-plans', {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({
      kitchenId: kitchen.id,
      weekStart: WEEK_START,
      days: [{
        tanggal: isoOffset(WEEK_START, 1),
        porsiByKategori: emptyPm(),
        slots: {},
        alergi: [],
        note: NOTE,
      }],
    }),
  });
  record('put:hari-kosong', emptyPut.res.ok && Boolean(emptyPut.body?.id), emptyPut.body?.error || emptyPut.body?.id);
  const planId = emptyPut.body?.id;

  const pubEmpty = await fetchJson(`/api/weekly-menu-plans/${planId}/publish`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ tanggal: isoOffset(WEEK_START, 1) }),
  });
  record('gate:publish-kosong', pubEmpty.res.status === 400 && /resep|penerima manfaat/i.test(String(pubEmpty.body?.error || '')), pubEmpty.body?.error);

  const bySlot = new Map();
  for (const r of recipes) {
    if (!bySlot.has(r.kategoriMenu)) bySlot.set(r.kategoriMenu, r);
  }
  const primary = bySlot.get('BUAH') || recipes[0];
  const alergi = recipes.find((r) => r.id !== primary.id);
  const extra = [...bySlot.values()].find((r) => r.id !== primary.id && r.id !== alergi.id);
  const mondaySlots = { [primary.kategoriMenu]: [primary.id] };
  if (extra?.kategoriMenu) mondaySlots[extra.kategoriMenu] = [extra.id];

  const save = await fetchJson('/api/weekly-menu-plans', {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({
      kitchenId: kitchen.id,
      weekStart: WEEK_START,
      days: [{
        tanggal: WEEK_START,
        porsiByKategori: { ...PM6 },
        slots: mondaySlots,
        note: NOTE,
        alergi: [{ recipeId: alergi.id, porsi: 3, catatan: 'E2E alergi' }],
      }],
    }),
  });
  const monday = (save.body?.days || []).find((d) => d.tanggal === WEEK_START);
  const totalPm = Object.values(PM6).reduce((a, b) => a + b, 0);
  record(
    'put:senin-pm-slot-alergi',
    save.res.ok
      && save.body?.days?.length === 5
      && monday?.porsiByKategori?.PORSI_KECIL === 40
      && monday?.porsiByKategori?.POSYANDU_BUSUI === 4
      && monday?.slots?.[primary.kategoriMenu]?.includes(primary.id)
      && monday?.note === NOTE
      && monday?.alergi?.[0]?.recipeId === alergi.id
      && monday?.alergi?.[0]?.porsi === 3
      && !monday?.productionPlanId,
    save.body?.error || `${primary.kode} + alergi ${alergi.kode}`,
  );

  const got = await fetchJson(
    `/api/weekly-menu-plans?kitchenId=${encodeURIComponent(kitchen.id)}&weekStart=${WEEK_START}`,
    { headers: h },
  );
  record('get:minggu', got.res.ok && got.body?.id === save.body?.id && got.body?.days?.[0]?.porsiByKategori?.PORSI_BESAR === 80, got.body?.id);

  const gizi = await fetchJson('/api/nutrition-profiles/analyze-draft', {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      akg: 'PORSI_BESAR',
      acuanByKategori: { ...PM6 },
      lines: [{ recipeId: primary.id, targetPorsi: totalPm, kategoriPorsiList: Object.keys(PM6) }],
    }),
  });
  record(
    'gizi:analyze-draft',
    gizi.res.ok && Boolean(gizi.body?.perPorsi) && Boolean(gizi.body?.akgProfile || gizi.body?.akg),
    gizi.body?.error || `akg=${gizi.body?.akgProfile || gizi.body?.akg} kkal=${gizi.body?.perPorsi?.energiKcal}`,
  );

  const pub = await fetchJson(`/api/weekly-menu-plans/${save.body.id}/publish`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ tanggal: WEEK_START }),
  });
  const published = pub.body?.published?.[0];
  const pubMonday = (pub.body?.days || []).find((d) => d.tanggal === WEEK_START);
  record(
    'publish:senin-rpn',
    pub.res.ok
      && published?.tanggal === WEEK_START
      && /RPN/i.test(String(published?.productionPlanNo || ''))
      && Boolean(pubMonday?.productionPlanId)
      && pub.body?.status === 'PUBLISHED',
    pub.body?.error || published?.productionPlanNo,
  );

  const plans = await fetchJson(
    `/api/production-plans?tanggal=${WEEK_START}&kitchenId=${encodeURIComponent(kitchen.id)}`,
    { headers: h },
  );
  const rpn = (plans.body || []).find((p) => p.id === pubMonday?.productionPlanId)
    || (plans.body || []).find((p) => p.weeklyMenuPlanId === save.body.id);
  const lines = rpn?.lines || [];
  record(
    'rpn:lines-porsi-alergi',
    Boolean(rpn)
      && rpn.status === 'DRAFT'
      && rpn.weeklyMenuPlanId === save.body.id
      && lines.some((l) => l.recipeId === primary.id && Number(l.targetPorsi) === totalPm)
      && lines.some((l) => l.recipeId === alergi.id && Number(l.targetPorsi) === 3),
    rpn ? `${rpn.noDokumen} lines=${lines.length}` : `status=${plans.res.status}`,
  );

  const pt = await fetchJson(
    `/api/portion-targets?tanggal=${WEEK_START}&kitchenId=${encodeURIComponent(kitchen.id)}`,
    { headers: h },
  );
  const targets = pt.body?.targets || {};
  record(
    'portion-targets:6-kunci',
    pt.res.ok
      && Number(targets.PORSI_KECIL) === 40
      && Number(targets.PORSI_BESAR) === 80
      && Number(targets.POSYANDU_BALITA) === 10
      && Number(targets.POSYANDU_BUMIL) === 5
      && Number(targets.POSYANDU_BUSUI) === 4
      && Number(targets.ORGANOLEPTIK) === 2,
    JSON.stringify(targets),
  );

  const pubAgain = await fetchJson(`/api/weekly-menu-plans/${save.body.id}/publish`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ tanggal: WEEK_START }),
  });
  record(
    'publish:idempotent-draft',
    pubAgain.res.ok && pubAgain.body?.published?.[0]?.productionPlanId === pubMonday?.productionPlanId,
    pubAgain.body?.error || pubAgain.body?.published?.[0]?.productionPlanNo,
  );

  const copyDays = (got.body?.days || []).map((d, i) => ({
    tanggal: isoOffset(COPY_WEEK, i),
    porsiByKategori: d.porsiByKategori,
    slots: d.slots || {},
    alergi: d.alergi || [],
    note: i === 0 ? NOTE : '',
  }));
  const copyPut = await fetchJson('/api/weekly-menu-plans', {
    method: 'PUT',
    headers: h,
    body: JSON.stringify({ kitchenId: kitchen.id, weekStart: COPY_WEEK, days: copyDays }),
  });
  const copiedMon = (copyPut.body?.days || [])[0];
  record(
    'copy:minggu-tanpa-rpn',
    copyPut.res.ok
      && copyPut.body?.days?.length === 5
      && !copiedMon?.productionPlanId
      && copiedMon?.slots?.[primary.kategoriMenu]?.includes(primary.id)
      && copyPut.body?.status === 'DRAFT',
    copyPut.body?.error || copyPut.body?.id,
  );

  const withItems = (menusRes.body || []).find((m) => m.aktif !== false && (m.items || []).some((i) => i.recipeId));
  if (withItems) {
    const packageSlots = {};
    const seen = new Set();
    for (const item of withItems.items || []) {
      const recipeId = String(item.recipeId || '').trim();
      const rec = recipes.find((r) => r.id === recipeId);
      const slot = rec?.kategoriMenu || item.kategoriMenu;
      if (!recipeId || !slot || seen.has(recipeId)) continue;
      seen.add(recipeId);
      packageSlots[slot] = [...(packageSlots[slot] || []), recipeId];
    }
    if (seen.size) {
      const pkgPut = await fetchJson('/api/weekly-menu-plans', {
        method: 'PUT',
        headers: h,
        body: JSON.stringify({
          kitchenId: kitchen.id,
          weekStart: COPY_WEEK,
          days: [{
            tanggal: isoOffset(COPY_WEEK, 2),
            porsiByKategori: { ...PM6 },
            slots: packageSlots,
            alergi: [],
            note: `${NOTE} paket`,
          }],
        }),
      });
      const wed = (pkgPut.body?.days || []).find((d) => d.tanggal === isoOffset(COPY_WEEK, 2));
      record(
        'paket:isi-slot-rabu',
        pkgPut.res.ok && Object.keys(wed?.slots || {}).length > 0,
        pkgPut.body?.error || `${withItems.kode} slots=${Object.keys(wed?.slots || {}).join(',')}`,
      );
    } else {
      record('paket:isi-slot-rabu', true, 'skipped — item paket tanpa kategori');
    }
  } else {
    record('paket:isi-slot-rabu', true, 'skipped — belum ada master menu');
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  if (failed.length) {
    console.log('Gagal:', failed.map((f) => `${f.name} (${f.detail})`).join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
