import { test, expect, type APIResponse, type Page } from '@playwright/test';

/**
 * E2E Playwright UI+API modul Perencanaan Menu (Fase 0–4).
 * Mutasi memakai minggu terisolasi 2029-03-05 agar tidak menimpa RPN operasional.
 * Jika Chromium tidak bisa launch (libnss/libnspr), pakai:
 *   APP_URL=http://127.0.0.1:3001 npm run test:menu-planning-e2e
 */
const email = process.env.E2E_EMAIL || process.env.E2E_MASTER_EMAIL || 'dawam@master.com';
const password = process.env.E2E_PASSWORD || process.env.E2E_MASTER_PASSWORD || 'dawam123';
const tenantId = process.env.E2E_TENANT || 'sppg';

const WEEK_START = '2029-03-05'; // Senin
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
} as const;

type RecipeRow = {
  id: string;
  kode?: string;
  nama?: string;
  aktif?: boolean;
  kategoriMenu?: string | null;
  lines?: unknown[];
};

type KitchenRow = { id: string; kode?: string; nama?: string; aktif?: boolean };
type MenuRow = {
  id: string;
  kode?: string;
  nama?: string;
  aktif?: boolean;
  items?: Array<{ recipeId?: string; kategoriMenu?: string }>;
};
type WeeklyDay = {
  tanggal: string;
  porsiByKategori?: Record<string, number>;
  slots?: Record<string, string[]>;
  note?: string;
  alergi?: Array<{ recipeId: string; porsi: number; catatan?: string }>;
  productionPlanId?: string;
  productionPlanNo?: string;
};
type WeeklyDoc = {
  id?: string;
  exists?: boolean;
  kitchenId?: string;
  weekStart?: string;
  status?: string;
  days?: WeeklyDay[];
  published?: Array<{ tanggal: string; productionPlanId: string; productionPlanNo: string }>;
  warnings?: string[];
  error?: string;
};

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole('button', { name: /masuk/i }).click();

  const tenantSelect = page.locator('#tenant');
  if (await tenantSelect.isVisible({ timeout: 4_000 }).catch(() => false)) {
    const opt = tenantSelect.locator(`option[value="${tenantId}"]`);
    if (await opt.count()) {
      await tenantSelect.selectOption(tenantId);
    } else {
      const first = tenantSelect.locator('option:not([value=""])').first();
      const value = await first.getAttribute('value');
      if (value) await tenantSelect.selectOption(value);
    }
    await page.getByRole('button', { name: /masuk/i }).click();
  }

  await expect(page).toHaveURL(/\/(dashboard|pembelian-po|hutang|food-production)/, { timeout: 25_000 });
}

async function jsonOf(res: APIResponse) {
  try {
    return await res.json();
  } catch {
    return null;
  }
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

function isoOffset(start: string, days: number) {
  const [y, m, d] = start.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function usableRecipes(list: RecipeRow[]) {
  return list.filter((r) => (
    r.aktif !== false
    && r.id
    && r.kategoriMenu
    && Array.isArray(r.lines)
    && r.lines.length > 0
  ));
}

test.describe.configure({ mode: 'serial' });

test.describe('Perencanaan Menu — e2e menyeluruh', () => {
  test.setTimeout(180_000);

  test('API gate: dapur wajib, weekStart Senin, resep duplikat, terbit tanpa porsi/slot', async ({ page }) => {
    await login(page);
    const api = page.request;

    const noKitchen = await api.get(`/api/weekly-menu-plans?weekStart=${WEEK_START}`);
    expect(noKitchen.status()).toBe(400);
    expect(String((await jsonOf(noKitchen))?.error || '')).toMatch(/dapur/i);

    const tuesday = await api.get(`/api/weekly-menu-plans?kitchenId=${PREFERRED_KITCHEN}&weekStart=2029-03-06`);
    expect(tuesday.status()).toBe(400);
    expect(String((await jsonOf(tuesday))?.error || '')).toMatch(/senin/i);

    const kitchensRes = await api.get('/api/kitchens?aktif=1');
    expect(kitchensRes.ok()).toBeTruthy();
    const kitchens = (await jsonOf(kitchensRes)) as KitchenRow[];
    const kitchen = kitchens.find((k) => k.id === PREFERRED_KITCHEN) || kitchens[0];
    expect(kitchen?.id).toBeTruthy();

    const recipesRes = await api.get('/api/recipes?aktif=1');
    expect(recipesRes.ok()).toBeTruthy();
    const recipes = usableRecipes((await jsonOf(recipesRes)) as RecipeRow[]);
    expect(recipes.length).toBeGreaterThan(0);
    const slotRecipe = recipes[0];
    const otherSlot = slotRecipe.kategoriMenu === 'GARNISH' ? 'KARBOHIDRAT' : 'GARNISH';

    const dup = await api.put('/api/weekly-menu-plans', {
      data: {
        kitchenId: kitchen.id,
        weekStart: WEEK_START,
        days: [{
          tanggal: WEEK_START,
          porsiByKategori: { ...PM6 },
          slots: {
            [slotRecipe.kategoriMenu as string]: [slotRecipe.id],
            [otherSlot]: [slotRecipe.id],
          },
          alergi: [],
        }],
      },
    });
    expect(dup.status()).toBe(400);
    expect(String((await jsonOf(dup))?.error || '')).toMatch(/dua kali|duplikat/i);

    const emptyPublishPut = await api.put('/api/weekly-menu-plans', {
      data: {
        kitchenId: kitchen.id,
        weekStart: WEEK_START,
        days: [{
          tanggal: isoOffset(WEEK_START, 1),
          porsiByKategori: emptyPm(),
          slots: {},
          alergi: [],
          note: NOTE,
        }],
      },
    });
    expect(emptyPublishPut.ok()).toBeTruthy();
    const saved = (await jsonOf(emptyPublishPut)) as WeeklyDoc;
    expect(saved.id).toBeTruthy();

    const pubEmpty = await api.post(`/api/weekly-menu-plans/${saved.id}/publish`, {
      data: { tanggal: isoOffset(WEEK_START, 1) },
    });
    expect(pubEmpty.status()).toBe(400);
    expect(String((await jsonOf(pubEmpty))?.error || '')).toMatch(/resep|penerima manfaat/i);
  });

  test('API journey: PM 6 kunci, slot master, alergi, gizi, terbit RPN, salin minggu, paket', async ({ page }) => {
    await login(page);
    const api = page.request;

    const kitchens = (await jsonOf(await api.get('/api/kitchens?aktif=1'))) as KitchenRow[];
    const kitchen = kitchens.find((k) => k.id === PREFERRED_KITCHEN)
      || kitchens.find((k) => /DPRKPJ2|Kepanjen 2/i.test(`${k.kode} ${k.nama}`))
      || kitchens[0];
    expect(kitchen?.id).toBeTruthy();

    const recipes = usableRecipes(
      (await jsonOf(await api.get('/api/recipes?aktif=1'))) as RecipeRow[],
    );
    expect(recipes.length).toBeGreaterThan(1);
    const bySlot = new Map<string, RecipeRow>();
    for (const r of recipes) {
      const slot = String(r.kategoriMenu);
      if (!bySlot.has(slot)) bySlot.set(slot, r);
    }
    const primary = bySlot.get('BUAH') || recipes[0];
    const alergi = recipes.find((r) => r.id !== primary.id) || recipes[1];
    expect(alergi.id).not.toBe(primary.id);

    const menus = (await jsonOf(await api.get('/api/menus?aktif=1'))) as MenuRow[];
    const servicePoints = await jsonOf(
      await api.get(`/api/service-points?aktif=1&kitchenId=${encodeURIComponent(kitchen.id)}`),
    );
    expect(Array.isArray(servicePoints)).toBeTruthy();

    const mondaySlots: Record<string, string[]> = {
      [String(primary.kategoriMenu)]: [primary.id],
    };
    const extra = [...bySlot.values()].find((r) => r.id !== primary.id && r.id !== alergi.id);
    if (extra?.kategoriMenu) mondaySlots[extra.kategoriMenu] = [extra.id];

    const putRes = await api.put('/api/weekly-menu-plans', {
      data: {
        kitchenId: kitchen.id,
        weekStart: WEEK_START,
        days: [{
          tanggal: WEEK_START,
          porsiByKategori: { ...PM6 },
          slots: mondaySlots,
          note: NOTE,
          alergi: [{ recipeId: alergi.id, porsi: 3, catatan: 'E2E alergi' }],
        }],
      },
    });
    expect(putRes.ok(), String((await jsonOf(putRes))?.error || putRes.status())).toBeTruthy();
    const saved = (await jsonOf(putRes)) as WeeklyDoc;
    expect(saved.id).toBeTruthy();
    expect(saved.weekStart).toBe(WEEK_START);
    expect(saved.days).toHaveLength(5);
    const monday = saved.days!.find((d) => d.tanggal === WEEK_START)!;
    expect(monday.porsiByKategori).toMatchObject(PM6);
    expect(monday.slots?.[String(primary.kategoriMenu)]).toContain(primary.id);
    expect(monday.note).toBe(NOTE);
    expect(monday.alergi?.[0]).toMatchObject({ recipeId: alergi.id, porsi: 3 });
    expect(monday.productionPlanId).toBeFalsy();

    const getRes = await api.get(
      `/api/weekly-menu-plans?kitchenId=${encodeURIComponent(kitchen.id)}&weekStart=${WEEK_START}`,
    );
    expect(getRes.ok()).toBeTruthy();
    const got = (await jsonOf(getRes)) as WeeklyDoc;
    expect(got.id).toBe(saved.id);
    expect(got.days?.[0]?.porsiByKategori?.PORSI_KECIL).toBe(40);

    const giziRes = await api.post('/api/nutrition-profiles/analyze-draft', {
      data: {
        akg: 'PORSI_BESAR',
        acuanByKategori: { ...PM6 },
        lines: [
          {
            recipeId: primary.id,
            targetPorsi: 141,
            kategoriPorsiList: Object.keys(PM6),
          },
        ],
      },
    });
    expect(giziRes.ok(), String((await jsonOf(giziRes))?.error || giziRes.status())).toBeTruthy();
    const gizi = await jsonOf(giziRes);
    expect(gizi?.akgProfile || gizi?.akg).toBeTruthy();
    expect(gizi?.perPorsi).toBeTruthy();

    const pubRes = await api.post(`/api/weekly-menu-plans/${saved.id}/publish`, {
      data: { tanggal: WEEK_START },
    });
    const pubBody = (await jsonOf(pubRes)) as WeeklyDoc;
    expect(pubRes.ok(), String(pubBody?.error || pubRes.status())).toBeTruthy();
    expect(pubBody.published?.[0]?.tanggal).toBe(WEEK_START);
    expect(pubBody.published?.[0]?.productionPlanNo).toMatch(/RPN/i);
    const publishedMonday = pubBody.days?.find((d) => d.tanggal === WEEK_START);
    expect(publishedMonday?.productionPlanId).toBeTruthy();
    expect(pubBody.status).toBe('PUBLISHED');

    const planId = publishedMonday!.productionPlanId as string;
    const planRes = await api.get(
      `/api/production-plans?tanggal=${WEEK_START}&kitchenId=${encodeURIComponent(kitchen.id)}`,
    );
    expect(planRes.ok()).toBeTruthy();
    const plans = (await jsonOf(planRes)) as Array<Record<string, unknown>>;
    const rpn = plans.find((p) => p.id === planId) || plans.find((p) => p.weeklyMenuPlanId === saved.id);
    expect(rpn).toBeTruthy();
    expect(rpn!.status).toBe('DRAFT');
    expect(rpn!.weeklyMenuPlanId).toBe(saved.id);
    const lines = rpn!.lines as Array<{ recipeId?: string; targetPorsi?: number; notes?: string }>;
    expect(lines.some((l) => l.recipeId === primary.id && Number(l.targetPorsi) === 141)).toBeTruthy();
    expect(lines.some((l) => l.recipeId === alergi.id && Number(l.targetPorsi) === 3)).toBeTruthy();

    const ptRes = await api.get(
      `/api/portion-targets?tanggal=${WEEK_START}&kitchenId=${encodeURIComponent(kitchen.id)}`,
    );
    expect(ptRes.ok()).toBeTruthy();
    const pt = await jsonOf(ptRes);
    expect(pt?.targets || pt).toBeTruthy();
    const targets = (pt?.targets || pt) as Record<string, number>;
    expect(Number(targets.PORSI_KECIL)).toBe(40);
    expect(Number(targets.PORSI_BESAR)).toBe(80);
    expect(Number(targets.POSYANDU_BUSUI)).toBe(4);

    const pubAgain = await api.post(`/api/weekly-menu-plans/${saved.id}/publish`, {
      data: { tanggal: WEEK_START },
    });
    const againBody = (await jsonOf(pubAgain)) as WeeklyDoc;
    expect(pubAgain.ok(), String(againBody?.error || pubAgain.status())).toBeTruthy();
    expect(againBody.published?.[0]?.productionPlanId).toBe(planId);

    const copyDays = (got.days || []).map((d, i) => ({
      tanggal: isoOffset(COPY_WEEK, i),
      porsiByKategori: d.porsiByKategori,
      slots: d.slots || {},
      alergi: d.alergi || [],
      note: i === 0 ? NOTE : '',
    }));
    const copyPut = await api.put('/api/weekly-menu-plans', {
      data: { kitchenId: kitchen.id, weekStart: COPY_WEEK, days: copyDays },
    });
    expect(copyPut.ok(), String((await jsonOf(copyPut))?.error || copyPut.status())).toBeTruthy();
    const copied = (await jsonOf(copyPut)) as WeeklyDoc;
    expect(copied.days).toHaveLength(5);
    expect(copied.days![0].productionPlanId).toBeFalsy();
    expect(copied.days![0].slots?.[String(primary.kategoriMenu)]).toContain(primary.id);
    expect(copied.status).toBe('DRAFT');

    const withItems = (Array.isArray(menus) ? menus : []).find((m) => (
      m.aktif !== false && (m.items || []).some((i) => i.recipeId)
    ));
    if (withItems) {
      const packageSlots: Record<string, string[]> = {};
      const seen = new Set<string>();
      for (const item of withItems.items || []) {
        const recipeId = String(item.recipeId || '').trim();
        const rec = recipes.find((r) => r.id === recipeId);
        const slot = rec?.kategoriMenu || item.kategoriMenu;
        if (!recipeId || !slot || seen.has(recipeId)) continue;
        seen.add(recipeId);
        packageSlots[slot] = [...(packageSlots[slot] || []), recipeId];
      }
      if (seen.size) {
        const pkgPut = await api.put('/api/weekly-menu-plans', {
          data: {
            kitchenId: kitchen.id,
            weekStart: COPY_WEEK,
            days: [{
              tanggal: isoOffset(COPY_WEEK, 2),
              porsiByKategori: { ...PM6 },
              slots: packageSlots,
              alergi: [],
              note: `${NOTE} paket`,
            }],
          },
        });
        expect(pkgPut.ok(), String((await jsonOf(pkgPut))?.error || pkgPut.status())).toBeTruthy();
      }
    }

    await page.goto(
      `/food-production/menu-plan?weekStart=${WEEK_START}&kitchenId=${encodeURIComponent(kitchen.id)}`,
    );
    await expect(page.getByRole('heading', { name: /Perencanaan Menu/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/5 Maret 2029/i).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Senin · 05\/03/)).toBeVisible();
    await expect(page.getByText(/Selasa · 06\/03/)).toBeVisible();
    await expect(page.getByText(/Jumat · 09\/03/)).toBeVisible();

    for (const label of ['Karbohidrat', 'Lauk Nabati', 'Lauk Hewani', 'Sayur', 'Buah', 'Susu', 'Garnish']) {
      await expect(page.getByRole('columnheader', { name: label }).or(page.getByText(label, { exact: true })).first()).toBeVisible();
    }
    for (const label of ['PK Sekolah', 'PB Sekolah', 'PK Balita', 'PB Bumil', 'PB Busui', 'PB Organoleptik']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }

    if (primary.kode) {
      await expect(page.getByText(new RegExp(primary.kode)).first()).toBeVisible({ timeout: 15_000 });
    }
    await expect(page.getByText(NOTE).first()).toBeVisible();
    await expect(page.getByText(/RPN/i).first()).toBeVisible();

    await expect(page.getByRole('button', { name: /Terapkan paket/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Salin minggu lalu/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Isi PM dari titik layanan/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Terbitkan minggu/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Unduh PDF acuan kerja/i })).toBeVisible();

    await page.getByRole('button', { name: /Terapkan paket/i }).first().click();
    await expect(page.getByRole('heading', { name: /Terapkan paket menu/i })).toBeVisible();
    await expect(page.getByText(/Resep master menentukan kategori/i)).toBeVisible();
    await page.getByRole('button', { name: /^Batal$/i }).click();

    await page.getByRole('button', { name: /Salin minggu lalu/i }).click();
    await expect(page.getByRole('heading', { name: /Salin minggu lalu/i })).toBeVisible();
    await expect(page.getByText(/Salin porsi \(PM\) juga/i)).toBeVisible();
    await page.getByRole('button', { name: /^Batal$/i }).click();

    await page.getByRole('button', { name: /Isi PM dari titik layanan/i }).click();
    const prefillTitle = page.getByRole('heading', { name: /titik layanan/i });
    const prefillToast = page.getByText(/Titik layanan dapur ini belum punya porsi|Gagal memuat titik layanan/i);
    await expect(prefillTitle.or(prefillToast).first()).toBeVisible({ timeout: 15_000 });
    if (await prefillTitle.isVisible().catch(() => false)) {
      await expect(page.getByText(/Hari terpilih saja/i)).toBeVisible();
      await page.getByRole('button', { name: /^Batal$/i }).click();
    }

    await page.getByRole('button', { name: /Unduh PDF acuan kerja/i }).click();
    await expect(page.getByText(/ACUAN KERJA DAPUR/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/REKAP TOTAL BAHAN/i).first()).toBeVisible();
    await expect(page.getByText(/DRAFT/i).first()).toBeVisible();
    await page.getByRole('button', { name: /^Tutup$/i }).click();

    const giziChip = page.getByText(/Tanpa data TKPI|kkal|Menghitung gizi|Gizi…/i).first();
    await expect(giziChip).toBeVisible({ timeout: 20_000 });

    await page.goto('/food-production/menu');
    await expect(page.getByText(/Paket resep per kategori menu/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('link', { name: /Perencanaan Menu/i })).toBeVisible();
  });
});
