import { test, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';

/**
 * E2E kelola bahan Fase 0–6 di tenant uji sekali pakai (dibuat & dihapus oleh tes ini).
 * Kontrol stok, maker-checker penyesuaian, role GRN, siklus RL, rekonsiliasi, dan halaman UI terkait.
 */
const email = process.env.E2E_MASTER_EMAIL || 'dawam@master.com';
const password = process.env.E2E_MASTER_PASSWORD || 'dawam123';
const baseURL = process.env.APP_URL || `http://${process.env.APP_HOST || '127.0.0.1'}:${process.env.APP_PORT || '3001'}`;

const T = `e2ekb${Date.now().toString(36)}`;
const PW = 'e2e-pass-123';
const users = {
  gudang: { email: `gudang@${T}.test`, role: 'GUDANG' },
  spv: { email: `spv@${T}.test`, role: 'SUPERVISOR' },
  spv2: { email: `spv2@${T}.test`, role: 'SUPERVISOR' },
  driver: { email: `driver@${T}.test`, role: 'DRIVER' },
} as const;

async function apiLogin(mail: string, pass: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL });
  const res = await ctx.post('/api/auth/login', { data: { email: mail, password: pass } });
  expect(res.ok(), `login ${mail}: ${await res.text()}`).toBeTruthy();
  return ctx;
}

async function json(res: Awaited<ReturnType<APIRequestContext['get']>>) {
  const text = await res.text();
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { raw: text }; }
}

test.describe.configure({ mode: 'serial' });

test.describe('Kelola bahan Fase 0–6 (tenant uji terisolasi)', () => {
  let master: APIRequestContext;
  const ctx: Partial<Record<keyof typeof users, APIRequestContext>> = {};
  let productId = '';

  const q = (path: string) => `/api${path}${path.includes('?') ? '&' : '?'}tenantId=${T}`;
  const productStok = async () => {
    const res = await master.get(q(`/products/${productId}`));
    return Number((await json(res)).stok);
  };

  test.beforeAll(async () => {
    master = await apiLogin(email, password);
    const created = await master.post('/api/tenants', { data: { tenantId: T, tenantName: `E2E Kelola Bahan ${T}` } });
    expect(created.ok(), await created.text()).toBeTruthy();
    for (const [name, u] of Object.entries(users)) {
      const res = await master.post('/api/users', {
        data: { email: u.email, password: PW, name: `${name}-${T}`, role: u.role, tenantId: T, tenantName: T },
      });
      expect(res.ok(), `user ${name}: ${await res.text()}`).toBeTruthy();
      ctx[name as keyof typeof users] = await apiLogin(u.email, PW);
    }
  });

  test.afterAll(async () => {
    const del = await master.delete(`/api/tenants/${T}?force=true`, { data: { confirmPhrase: 'DELETE TENANT' } });
    expect(del.ok(), await del.text()).toBeTruthy();
    for (const c of Object.values(ctx)) await c?.dispose();
    await master.dispose();
  });

  test('produk baru dengan stok awal: boleh saat approval nonaktif, ditolak saat aktif', async () => {
    const base = { tenantId: T, satuan: 'KG', grup: 'Sembako', itemRole: 'INGREDIENT', gudangKode: 'GKERING', hargaBeli: 1000 };
    const ok = await master.post(q('/products'), { data: { ...base, kode: `BRS-${T}`, nama: 'Beras E2E KB', stok: 10 } });
    expect(ok.status(), await ok.text()).toBe(200);
    productId = String((await json(ok)).id);
    expect(await productStok()).toBe(10);

    const flag = await master.put('/api/tenant/settings', { data: { tenantId: T, features: { adjustmentApproval: true } } });
    expect(flag.ok(), await flag.text()).toBeTruthy();

    const blocked = await master.post(q('/products'), { data: { ...base, kode: `GLA-${T}`, nama: 'Gula E2E KB', stok: 5 } });
    expect(blocked.status()).toBe(400);
    expect(String((await json(blocked)).error)).toMatch(/Persetujuan penyesuaian aktif/);
  });

  test('penyesuaian maker-checker: GUDANG hitung & ajukan, pembuat tidak bisa setujui, Supervisor setujui', async () => {
    const draft = await ctx.gudang!.post('/api/stok/penyesuaian', { data: { items: [{ stokId: productId }] } });
    expect(draft.status(), await draft.text()).toBe(200);
    const doc = await json(draft);
    expect(doc.status).toBe('DRAFT');
    const id = String(doc.id);

    const edit = await ctx.gudang!.put(`/api/stok/penyesuaian/${id}`, {
      data: { reasonCode: 'OPNAME', items: [{ stokId: productId, qtyAktual: 8 }] },
    });
    expect(edit.status(), await edit.text()).toBe(200);
    const submit = await ctx.gudang!.post(`/api/stok/penyesuaian/${id}/submit`, { data: {} });
    expect((await json(submit)).status).toBe('PENDING_APPROVAL');

    expect((await ctx.gudang!.post(`/api/stok/penyesuaian/${id}/approve`, { data: {} })).status()).toBe(403);
    expect(await productStok()).toBe(10);

    const approve = await ctx.spv!.post(`/api/stok/penyesuaian/${id}/approve`, { data: {} });
    expect(approve.status(), await approve.text()).toBe(200);
    expect((await json(approve)).status).toBe('POSTED');
    expect(await productStok()).toBe(8);
  });

  test('GRN: role tanpa hak posting ditolak sebelum menyentuh dokumen', async () => {
    const res = await ctx.driver!.post('/api/goods-receipts/tidak-ada/post', { data: {} });
    expect(res.status()).toBe(403);
    const sync = await ctx.driver!.post('/api/goods-receipts/sync-shipped', { data: {} });
    expect(sync.status()).toBe(403);
  });

  test('RL non-produksi: GUDANG buat & ajukan, Supervisor tolak, stok tidak berubah', async () => {
    const rlBody = { lokasiKode: 'GKERING', keperluan: 'Kebersihan kantor E2E', items: [{ stokId: productId, qty: 1 }] };
    expect((await ctx.spv!.post('/api/inventory-releases', { data: rlBody })).status()).toBe(403);
    const created = await ctx.gudang!.post('/api/inventory-releases', { data: rlBody });
    expect(created.status(), await created.text()).toBe(200);
    const rl = await json(created);
    expect(rl.status).toBe('DRAFT');

    const submit = await ctx.gudang!.post(`/api/inventory-releases/${rl.id}/submit`, { data: {} });
    expect(submit.status(), await submit.text()).toBe(200);
    expect((await json(submit)).status).toBe('PENDING_APPROVAL');

    expect((await ctx.gudang!.post(`/api/inventory-releases/${rl.id}/reject`, { data: { reason: 'x' } })).status()).toBe(403);
    const reject = await ctx.spv!.post(`/api/inventory-releases/${rl.id}/reject`, { data: { reason: 'Uji E2E' } });
    expect(reject.status(), await reject.text()).toBe(200);
    expect((await json(reject)).status).toBe('REJECTED');
    expect(await productStok()).toBe(8);
  });

  test('rekonsiliasi tenant: semua job selesai tanpa selisih', async () => {
    const res = await master.post('/api/ops/recon/run', { data: { tenantId: T } });
    expect(res.status(), await res.text()).toBe(200);
    const body = await json(res);
    const results = body.results as Array<{ job: string; status: string; totalMismatch: number }>;
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.totalMismatch, `${r.job} ${r.status}`).toBe(0);

    const latest = await master.get(`/api/ops/recon?tenantId=${T}`);
    expect(latest.ok()).toBeTruthy();
    expect(((await json(latest)).reports as unknown[]).length).toBeGreaterThan(0);
  });

  test('UI: halaman stok, produk, dan panel rekonsiliasi terbuka tanpa error', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    await loginUi(page);
    const acting = await page.request.post('/api/tenant/acting', { data: { tenantId: T } });
    expect(acting.ok(), await acting.text()).toBeTruthy();

    const pages: Array<[string, RegExp]> = [
      ['/produk', /Beras E2E KB/],
      ['/stok/penyesuaian', /Penyesuaian/i],
      ['/stok/release', /Release|Pengeluaran/i],
      ['/stok/kartu', /Kartu/i],
      ['/stok/saldo', /Saldo|Stok/i],
      ['/utiliti/ops', /Rekonsiliasi/i],
    ];
    for (const [path, expected] of pages) {
      await page.goto(path);
      await expect(page.locator('body')).toContainText(expected, { timeout: 60_000 });
      await expect(page.locator('body')).not.toContainText(/Application error|Unhandled Runtime Error|Internal Server Error/);
    }
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  });
});

async function loginUi(page: Page) {
  await page.goto('/');
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole('button', { name: /masuk/i }).click();
  await expect(page).toHaveURL(/\/(dashboard|utiliti|pembelian-po|produk)/, { timeout: 60_000 });
}
