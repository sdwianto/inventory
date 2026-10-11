import { test, expect, type APIResponse, type Page } from '@playwright/test';

/**
 * E2E PB/PK split per resep pada kategori menu multi-resep.
 * Minggu terisolasi 2029-04-02 agar tidak menimpa RPN operasional.
 */
const email = process.env.E2E_EMAIL || process.env.E2E_MASTER_EMAIL || 'dawam@master.com';
const password = process.env.E2E_PASSWORD || process.env.E2E_MASTER_PASSWORD || 'dawam123';
const tenantId = process.env.E2E_TENANT || 'sppg';

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
} as const;
const PB_TOTAL = 800 + 30 + 20 + 12;
const PK_TOTAL = 400 + 50;
const ALL = PB_TOTAL + PK_TOTAL;

type RecipeRow = { id: string; kode?: string; aktif?: boolean; kategoriMenu?: string | null; lines?: unknown[] };
type KitchenRow = { id: string };
type WeeklyDay = {
  tanggal: string;
  slots?: Record<string, string[]>;
  recipePorsiFamilies?: Record<string, string[]>;
  productionPlanId?: string;
};
type WeeklyDoc = {
  id?: string;
  days?: WeeklyDay[];
  published?: Array<{ tanggal: string; productionPlanId: string }>;
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
    await tenantSelect.selectOption(tenantId);
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

test.describe.configure({ mode: 'serial' });

test.describe('Perencanaan Menu — PB/PK split per resep', () => {
  test.setTimeout(240_000);

  let kitchenId = '';
  let slot = '';
  let a: RecipeRow;
  let b: RecipeRow;
  let filler: RecipeRow | undefined;

  async function setup(page: Page) {
    await login(page);
    const api = page.request;
    const kitchens = (await jsonOf(await api.get('/api/kitchens?aktif=1'))) as KitchenRow[];
    kitchenId = (kitchens.find((k) => k.id === PREFERRED_KITCHEN) || kitchens[0]).id;
    const recipes = ((await jsonOf(await api.get('/api/recipes?aktif=1'))) as RecipeRow[])
      .filter((r) => r.aktif !== false && r.kategoriMenu && Array.isArray(r.lines) && r.lines.length);
    const bySlot = new Map<string, RecipeRow[]>();
    for (const r of recipes) bySlot.set(String(r.kategoriMenu), [...(bySlot.get(String(r.kategoriMenu)) || []), r]);
    const pair = [...bySlot.entries()].find(([, list]) => list.length >= 2);
    expect(pair, 'butuh 2 resep aktif di satu kategori').toBeTruthy();
    slot = pair![0];
    [a, b] = pair![1];
    filler = recipes.find((r) => r.kategoriMenu !== slot);
  }

  function dayPayload(families?: Record<string, string[]>) {
    return {
      tanggal: DAY,
      porsiByKategori: { ...PM6 },
      slots: {
        [slot]: [a.id, b.id],
        ...(filler ? { [String(filler.kategoriMenu)]: [filler.id] } : {}),
      },
      ...(families !== undefined ? { recipePorsiFamilies: families } : {}),
      alergi: [],
    };
  }

  test('API: normalisasi, terbit RPN ter-split, peringatan cakupan', async ({ page }) => {
    await setup(page);
    const api = page.request;

    const empty = await api.put('/api/weekly-menu-plans', {
      data: { kitchenId, weekStart: WEEK_START, days: [dayPayload({ [a.id]: [] })] },
    });
    expect(empty.status()).toBe(400);
    expect(String((await jsonOf(empty))?.error)).toMatch(/minimal PB atau PK/);

    const put = await api.put('/api/weekly-menu-plans', {
      data: {
        kitchenId,
        weekStart: WEEK_START,
        days: [dayPayload({ [a.id]: ['BESAR'], [b.id]: ['KECIL'], ...(filler ? { [filler.id]: ['KECIL'] } : {}) })],
      },
    });
    const saved = (await jsonOf(put)) as WeeklyDoc;
    expect(put.ok(), saved?.error).toBeTruthy();
    const day = saved.days!.find((d) => d.tanggal === DAY)!;
    expect(day.recipePorsiFamilies).toEqual({ [a.id]: ['BESAR'], [b.id]: ['KECIL'] });

    const pub = await api.post(`/api/weekly-menu-plans/${saved.id}/publish`, { data: { tanggal: DAY } });
    const pubBody = (await jsonOf(pub)) as WeeklyDoc;
    expect(pub.ok(), pubBody?.error).toBeTruthy();
    const planId = pubBody.published![0].productionPlanId;
    const plans = (await jsonOf(await api.get(
      `/api/production-plans?tanggal=${DAY}&kitchenId=${encodeURIComponent(kitchenId)}`,
    ))) as Array<{ id: string; lines: Array<{ recipeId?: string; targetPorsi: number; kategoriPorsiList?: string[] }> }>;
    const rpn = plans.find((p) => p.id === planId)!;
    const lineA = rpn.lines.find((l) => l.recipeId === a.id)!;
    const lineB = rpn.lines.find((l) => l.recipeId === b.id)!;
    expect(lineA.targetPorsi).toBe(PB_TOTAL);
    expect(lineA.kategoriPorsiList).not.toContain('PORSI_KECIL');
    expect(lineB.targetPorsi).toBe(PK_TOTAL);
    expect(lineB.kategoriPorsiList?.sort()).toEqual(['PORSI_KECIL', 'POSYANDU_BALITA']);
    if (filler) expect(rpn.lines.find((l) => l.recipeId === filler!.id)!.targetPorsi).toBe(ALL);

    const gapPut = await api.put('/api/weekly-menu-plans', {
      data: { kitchenId, weekStart: WEEK_START, days: [dayPayload({ [a.id]: ['BESAR'], [b.id]: ['BESAR'] })] },
    });
    expect(gapPut.ok()).toBeTruthy();
    const gapPub = await api.post(`/api/weekly-menu-plans/${saved.id}/publish`, { data: { tanggal: DAY } });
    const gapBody = (await jsonOf(gapPub)) as WeeklyDoc;
    expect(gapPub.ok(), gapBody?.error).toBeTruthy();
    expect((gapBody.warnings || []).some((w) => new RegExp(`PK \\(${PK_TOTAL}\\) tidak ada resep`).test(w))).toBe(true);
    expect(gapBody.published![0].productionPlanId).toBe(planId);

    const reset = await api.put('/api/weekly-menu-plans', {
      data: { kitchenId, weekStart: WEEK_START, days: [dayPayload({})] },
    });
    const resetBody = (await jsonOf(reset)) as WeeklyDoc;
    expect(reset.ok()).toBeTruthy();
    expect(resetBody.days!.find((d) => d.tanggal === DAY)!.recipePorsiFamilies).toBeUndefined();
  });

  test('UI: checkbox PB/PK default tercentang, un-check mengubah porsi & tersimpan', async ({ page }) => {
    await setup(page);
    await page.goto(`/food-production/menu-plan?weekStart=${WEEK_START}&kitchenId=${encodeURIComponent(kitchenId)}`);
    await expect(page.getByRole('heading', { name: /Perencanaan Menu/i })).toBeVisible({ timeout: 30_000 });

    const rowA = page.getByTestId(`menu-slot-porsi-${DAY}-${a.id}`);
    const rowB = page.getByTestId(`menu-slot-porsi-${DAY}-${b.id}`);
    await expect(rowA).toBeVisible({ timeout: 20_000 });
    const fmt = (n: number) => n.toLocaleString('id-ID');
    await expect(rowA).toContainText(`PB (${fmt(PB_TOTAL)})`);
    await expect(rowA).toContainText(`PK (${fmt(PK_TOTAL)})`);
    await expect(rowA).toContainText(`= ${fmt(ALL)}`);
    const pbA = rowA.getByRole('checkbox', { name: /^PB untuk/ });
    const pkA = rowA.getByRole('checkbox', { name: /^PK untuk/ });
    await expect(pbA).toBeChecked();
    await expect(pkA).toBeChecked();

    await pkA.click();
    await expect(pkA).not.toBeChecked();
    await expect(rowA).toContainText(`= ${fmt(PB_TOTAL)}`);

    await pbA.click();
    await expect(page.getByText(/Pilih minimal PB atau PK/).first()).toBeVisible();
    await expect(pbA).toBeChecked();

    const pbB = rowB.getByRole('checkbox', { name: /^PB untuk/ });
    await pbB.click();
    await expect(rowB).toContainText(`= ${fmt(PK_TOTAL)}`);

    await page.waitForTimeout(2_500);
    const got = (await jsonOf(await page.request.get(
      `/api/weekly-menu-plans?kitchenId=${encodeURIComponent(kitchenId)}&weekStart=${WEEK_START}`,
    ))) as WeeklyDoc;
    expect(got.days!.find((d) => d.tanggal === DAY)!.recipePorsiFamilies).toEqual({
      [a.id]: ['BESAR'],
      [b.id]: ['KECIL'],
    });

    await pbB.click();
    await expect(rowB).toContainText(`= ${fmt(ALL)}`);
    await rowB.getByRole('checkbox', { name: /^PK untuk/ }).click();
    await expect(rowB).toContainText(`= ${fmt(PB_TOTAL)}`);
    await expect(page.getByText(`PK (${fmt(PK_TOTAL)}) belum ada resep`).first()).toBeVisible();

    await page.waitForTimeout(2_500);
    await page.reload();
    await expect(rowA).toBeVisible({ timeout: 20_000 });
    await expect(rowA.getByRole('checkbox', { name: /^PK untuk/ })).not.toBeChecked();
    await expect(rowB.getByRole('checkbox', { name: /^PK untuk/ })).not.toBeChecked();
    await expect(rowB).toContainText(`= ${fmt(PB_TOTAL)}`);
    await expect(page.getByText(`PK (${fmt(PK_TOTAL)}) belum ada resep`).first()).toBeVisible();
  });
});
