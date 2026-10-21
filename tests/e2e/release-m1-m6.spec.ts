import { test, expect, request as pwRequest, chromium, type APIRequestContext, type Page } from '@playwright/test';

/**
 * E2E Release Inventory perbaikan M1–M6 (tenant uji sekali pakai).
 * Jalankan vs `npm run dev` (Playwright webServer reuseExistingServer).
 *
 * Skenario:
 * - M1: duplikat stokId ditolak API
 * - M5: OPERATIONAL tanpa RPN OK meski keperluan mirip produksi
 * - M5: PRODUCTION tanpa RPN ditolak
 * - M5: legacy tanpa releaseKind + keperluan produksi ditolak
 * - M5: siklus OPERATIONAL buat → ajukan → setujui → stok berkurang
 * - M2: stok kurang / pesan error jelas
 * - M6: Panduan Release API + tombol UI
 * - M3: label / pilihan Jenis release di form UI
 */
const email = process.env.E2E_MASTER_EMAIL || 'dawam@master.com';
const password = process.env.E2E_MASTER_PASSWORD || 'dawam123';
/** Fallback akun bootstrap seed — password dari MASTER_BOOTSTRAP_PASSWORD (.env.local / CI). */
const bootstrapEmail = process.env.MASTER_BOOTSTRAP_EMAIL || 'master@dawam.com';
const bootstrapPassword = process.env.MASTER_BOOTSTRAP_PASSWORD || 'master123';
const baseURL = process.env.APP_URL || `http://${process.env.APP_HOST || '127.0.0.1'}:${process.env.APP_PORT || '3001'}`;
let uiEmail = email;
let uiPassword = password;

const T = `e2erl${Date.now().toString(36)}`;
const PW = 'e2e-pass-123';
const users = {
  gudang: { email: `gudang@${T}.test`, role: 'GUDANG' },
  spv: { email: `spv@${T}.test`, role: 'SUPERVISOR' },
} as const;

async function apiLogin(mail: string, pass: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL });
  const res = await ctx.post('/api/auth/login', { data: { email: mail, password: pass } });
  expect(res.ok(), `login ${mail}: ${await res.text()}`).toBeTruthy();
  return ctx;
}

async function apiLoginMaster(): Promise<APIRequestContext> {
  for (const [mail, pass] of [
    [email, password],
    [bootstrapEmail, bootstrapPassword],
  ] as const) {
    const ctx = await pwRequest.newContext({ baseURL });
    const res = await ctx.post('/api/auth/login', { data: { email: mail, password: pass } });
    if (res.ok()) {
      uiEmail = mail;
      uiPassword = pass;
      return ctx;
    }
    await ctx.dispose();
  }
  throw new Error(`Login master gagal untuk ${email} dan ${bootstrapEmail}`);
}

async function json(res: Awaited<ReturnType<APIRequestContext['get']>>) {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

async function loginUi(page: Page) {
  await page.goto('/');
  await page.getByLabel(/^email$/i).fill(uiEmail);
  await page.getByLabel(/^password$/i).fill(uiPassword);
  await page.getByRole('button', { name: /masuk/i }).click();
  await expect(page).toHaveURL(/\/(dashboard|utiliti|pembelian-po|produk)/, { timeout: 60_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('Release M1–M6 (tenant uji terisolasi)', () => {
  let master: APIRequestContext;
  const ctx: Partial<Record<keyof typeof users, APIRequestContext>> = {};
  let productId = '';
  let productId2 = '';

  const q = (path: string) => `/api${path}${path.includes('?') ? '&' : '?'}tenantId=${T}`;

  const productStok = async (id = productId) => {
    const res = await master.get(q(`/products/${id}`));
    return Number((await json(res)).stok);
  };

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    master = await apiLoginMaster();
    const created = await master.post('/api/tenants', {
      data: { tenantId: T, tenantName: `E2E Release M1-M6 ${T}` },
    });
    expect(created.ok(), await created.text()).toBeTruthy();

    // Matikan approval penyesuaian agar stok awal produk boleh di-seed.
    const flags = await master.put('/api/tenant/settings', {
      data: {
        tenantId: T,
        features: {
          adjustmentApproval: false,
          rlFromPoReference: true,
          pblReferenceMode: true,
          planStockReservation: true,
        },
      },
    });
    expect(flags.ok(), await flags.text()).toBeTruthy();

    for (const [name, u] of Object.entries(users)) {
      const res = await master.post('/api/users', {
        data: {
          email: u.email,
          password: PW,
          name: `${name}-${T}`,
          role: u.role,
          tenantId: T,
          tenantName: T,
        },
      });
      expect(res.ok(), `user ${name}: ${await res.text()}`).toBeTruthy();
      ctx[name as keyof typeof users] = await apiLogin(u.email, PW);
    }

    const base = {
      tenantId: T,
      satuan: 'KG',
      grup: 'Sembako',
      itemRole: 'INGREDIENT',
      gudangKode: 'GKERING',
      hargaBeli: 1000,
    };
    const p1 = await master.post(q('/products'), {
      data: { ...base, kode: `RL1-${T}`, nama: 'Gula E2E RL', stok: 20 },
    });
    expect(p1.status(), await p1.text()).toBe(200);
    productId = String((await json(p1)).id);

    const p2 = await master.post(q('/products'), {
      data: { ...base, kode: `RL2-${T}`, nama: 'Beras E2E RL', stok: 15 },
    });
    expect(p2.status(), await p2.text()).toBe(200);
    productId2 = String((await json(p2)).id);
  });

  test.afterAll(async () => {
    if (master) {
      const del = await master.delete(`/api/tenants/${T}?force=true`, {
        data: { confirmPhrase: 'DELETE TENANT' },
      });
      expect(del.ok(), await del.text()).toBeTruthy();
      await master.dispose();
    }
    for (const c of Object.values(ctx)) await c?.dispose();
  });

  test('M1: duplikat stokId dalam satu RL ditolak', async () => {
    const res = await ctx.gudang!.post('/api/inventory-releases', {
      data: {
        lokasiKode: 'GKERING',
        releaseKind: 'OPERATIONAL',
        keperluan: 'Uji duplikat SKU',
        items: [
          { stokId: productId, qty: 2 },
          { stokId: productId, qty: 3 },
        ],
      },
    });
    expect(res.status(), await res.text()).toBe(400);
    const body = await json(res);
    expect(String(body.error)).toMatch(/lebih dari sekali|satukan qty/i);
  });

  test('M5: OPERATIONAL + keperluan mirip produksi — tanpa RPN OK', async () => {
    const res = await ctx.gudang!.post('/api/inventory-releases', {
      data: {
        lokasiKode: 'GKERING',
        releaseKind: 'OPERATIONAL',
        keperluan: 'AYAM KREMES sampel QC',
        items: [{ stokId: productId, qty: 1 }],
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const doc = await json(res);
    expect(doc.status).toBe('DRAFT');
    expect(doc.releaseKind).toBe('OPERATIONAL');
    expect(doc.productionPlanId == null || doc.productionPlanId === '').toBeTruthy();
  });

  test('M5: PRODUCTION tanpa RPN ditolak saat create', async () => {
    const res = await ctx.gudang!.post('/api/inventory-releases', {
      data: {
        lokasiKode: 'GKERING',
        releaseKind: 'PRODUCTION',
        keperluan: 'Menu siang',
        items: [{ stokId: productId, qty: 1 }],
      },
    });
    expect(res.status(), await res.text()).toBe(400);
    const body = await json(res);
    expect(String(body.error)).toMatch(/Produksi|Rencana Produksi|RPN/i);
  });

  test('M5: PRODUCTION + teks excluded (Maintenance) tetap wajib RPN', async () => {
    const res = await ctx.gudang!.post('/api/inventory-releases', {
      data: {
        lokasiKode: 'GKERING',
        releaseKind: 'PRODUCTION',
        keperluan: 'Maintenance AC dapur',
        items: [{ stokId: productId, qty: 1 }],
      },
    });
    expect(res.status(), await res.text()).toBe(400);
    expect(String((await json(res)).error)).toMatch(/Produksi|Rencana Produksi|RPN/i);
  });

  test('M5 legacy: tanpa releaseKind + keperluan produksi → ditolak', async () => {
    const res = await ctx.gudang!.post('/api/inventory-releases', {
      data: {
        lokasiKode: 'GKERING',
        keperluan: 'AYAM KREMES',
        items: [{ stokId: productId, qty: 1 }],
      },
    });
    expect(res.status(), await res.text()).toBe(400);
    expect(String((await json(res)).error)).toMatch(/Produksi|Rencana Produksi|produksi/i);
  });

  test('M5 legacy: tanpa releaseKind + maintenance → OK', async () => {
    const res = await ctx.gudang!.post('/api/inventory-releases', {
      data: {
        lokasiKode: 'GKERING',
        keperluan: 'Maintenance AC',
        items: [{ stokId: productId2, qty: 1 }],
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await json(res)).status).toBe('DRAFT');
  });

  test('M2: qty melebihi stok — pesan jelas', async () => {
    const stok = await productStok();
    const res = await ctx.gudang!.post('/api/inventory-releases', {
      data: {
        lokasiKode: 'GKERING',
        releaseKind: 'OPERATIONAL',
        keperluan: 'Uji stok kurang',
        items: [{ stokId: productId, qty: stok + 50 }],
      },
    });
    expect(res.status(), await res.text()).toBe(400);
    const errMsg = String((await json(res)).error);
    expect(errMsg.length).toBeGreaterThan(10);
    expect(errMsg).toMatch(/stok|kurang|sisa|tidak cukup|GKERING/i);
  });

  test('siklus OPERATIONAL: ajukan → setujui → stok berkurang', async () => {
    const before = await productStok();
    const created = await ctx.gudang!.post('/api/inventory-releases', {
      data: {
        lokasiKode: 'GKERING',
        releaseKind: 'OPERATIONAL',
        keperluan: 'Sampel QC harian',
        items: [{ stokId: productId, qty: 2 }],
        submit: true,
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    const rl = await json(created);
    expect(rl.status).toBe('PENDING_APPROVAL');
    expect(rl.releaseKind).toBe('OPERATIONAL');

    expect(
      (await ctx.gudang!.post(`/api/inventory-releases/${rl.id}/approve`, { data: {} })).status(),
    ).toBe(403);

    const approve = await ctx.spv!.post(`/api/inventory-releases/${rl.id}/approve`, { data: {} });
    expect(approve.status(), await approve.text()).toBe(200);
    expect((await json(approve)).status).toBe('POSTED');
    expect(await productStok()).toBe(before - 2);
  });

  test('M6: Panduan Release API merespons', async () => {
    const res = await ctx.gudang!.get('/api/stok/panduan-release?warehouseKode=GKERING');
    expect(res.status(), await res.text()).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.rows)).toBeTruthy();
  });

  test('UI: Mode Operasional — Jenis release, Panduan, label jalur', async () => {
    // Tanpa fixture `browser` agar skip tidak memaksa launch Chromium.
    // WSL tanpa libnspr4: E2E_SKIP_BROWSER=1. API di atas sudah menutupi M1–M6.
    test.skip(
      !!process.env.PLAYWRIGHT_SKIP_UI || process.env.E2E_SKIP_BROWSER === '1',
      'PLAYWRIGHT_SKIP_UI / E2E_SKIP_BROWSER set',
    );

    let browser;
    try {
      browser = await chromium.launch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      test.skip(true, `Chromium tidak bisa launch (${msg.slice(0, 80)})`);
      return;
    }

    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    try {
      await loginUi(page);
      const acting = await page.request.post('/api/tenant/acting', { data: { tenantId: T } });
      expect(acting.ok(), await acting.text()).toBeTruthy();

      await page.goto('/stok/pengeluaran?mode=operasional');
      await expect(page.locator('body')).toContainText(/Mode Operasional|Release Inventory/i, {
        timeout: 60_000,
      });
      await expect(page.locator('body')).toContainText(/Bahan produksi hari ini|RL tertaut RPN/i);
      await expect(page.getByRole('button', { name: /Panduan Release/i })).toBeVisible();

      await page.getByRole('button', { name: /Panduan Release/i }).click();
      await expect(page.getByRole('heading', { name: /Panduan Release/i })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator('body')).toContainText(/Tambah ke RL|SOH|Tidak ada SOH/i);
      await page.getByRole('button', { name: /^Tutup$/i }).last().click();

      await page.getByRole('button', { name: /Buat Release/i }).click();
      await expect(page.getByText(/Jenis release/i)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Operasional lain|Produksi \(bahan menu\)/i).first()).toBeVisible();
      await expect(page.getByText(/Operasional lain: RPN tidak wajib|Produksi: pilih RPN/i)).toBeVisible();

      expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
    } finally {
      await page.close();
      await browser.close();
    }
  });
});
