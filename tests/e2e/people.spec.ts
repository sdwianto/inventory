import { test, expect, type APIResponse, type Page } from '@playwright/test';

/**
 * E2E Sprint 1 — master Personel (identitas, rekening, lampiran, transfer stub).
 * Data uji bertanda [E2E-PEOPLE] agar aman ditimpa tes berikutnya.
 */
const email = process.env.E2E_EMAIL || process.env.E2E_MASTER_EMAIL || 'dawam@master.com';
const password = process.env.E2E_PASSWORD || process.env.E2E_MASTER_PASSWORD || 'dawam123';
const tenantId = process.env.E2E_TENANT || 'sppg';

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

  await expect(page).toHaveURL(/\/(dashboard|pembelian-po|hutang|food-production|people)/, {
    timeout: 25_000,
  });
}

async function jsonOf(res: APIResponse) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function ensureActingTenant(page: Page) {
  const res = await page.request.post('/api/tenant/acting', {
    data: { tenantId },
  });
  expect(res.ok(), `acting tenant ${tenantId}: ${await res.text()}`).toBeTruthy();
}

test.describe.configure({ mode: 'serial' });

test.describe('Personel — Sprint 1 e2e', () => {
  test.setTimeout(120_000);

  const stamp = Date.now().toString().slice(-10);
  const nama = `[E2E-PEOPLE] Siti ${stamp}`;
  const nik = `3201${stamp.padStart(12, '0').slice(-12)}`;
  const accountNo = `88${stamp}`.slice(0, 16);
  let personId = '';
  let attachmentId = '';

  test('login, halaman /people, redirect URL lama', async ({ page }) => {
    await login(page);
    await ensureActingTenant(page);

    await page.goto('/people');
    await expect(page.getByRole('heading', { name: /^Personel$/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Tambah Personel/i })).toBeVisible();
    await expect(page.getByText(/Staff & relawan operasional/i)).toBeVisible();

    await page.goto('/food-production/people');
    await expect(page).toHaveURL(/\/people$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /^Personel$/i })).toBeVisible();
  });

  test('API: create, list tanpa filename, payments stub, lampiran auth, media publik 404', async ({ page }) => {
    await login(page);
    await ensureActingTenant(page);
    const api = page.request;

    const kitchensRes = await api.get('/api/kitchens?aktif=1');
    expect(kitchensRes.ok()).toBeTruthy();
    const kitchens = (await jsonOf(kitchensRes)) as Array<{ id: string }> | null;
    const kitchenId = kitchens?.[0]?.id;

    const created = await api.post('/api/people', {
      data: {
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
      },
    });
    expect(created.ok(), `POST /api/people ${created.status()} ${await created.text()}`).toBeTruthy();
    const doc = await jsonOf(created) as {
      id: string;
      kode: string;
      nama: string;
      attachments?: unknown[];
      attachmentCount?: number;
      paymentCount?: number;
    };
    expect(doc.id).toBeTruthy();
    expect(doc.kode).toMatch(/^KDP\d+$/);
    expect(doc.nama).toBe(nama);
    expect(JSON.stringify(doc)).not.toContain('filename');
    personId = doc.id;

    const listRes = await api.get('/api/people?aktif=1');
    expect(listRes.ok()).toBeTruthy();
    const list = await jsonOf(listRes) as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    const row = list.find((r) => r.id === personId);
    expect(row).toBeTruthy();
    expect(row).not.toHaveProperty('attachments');
    expect(JSON.stringify(list)).not.toContain('filename');

    const alias = await api.get('/api/kitchen-people?q=' + encodeURIComponent(nama));
    expect(alias.ok()).toBeTruthy();
    const aliasList = await jsonOf(alias) as Array<{ id: string }>;
    expect(aliasList.some((r) => r.id === personId)).toBe(true);

    const payRes = await api.get(`/api/people/${personId}/payments`);
    expect(payRes.ok()).toBeTruthy();
    const payBody = await jsonOf(payRes) as {
      items: unknown[];
      total?: number;
      totalAmount?: number;
      hasMore?: boolean;
    };
    expect(Array.isArray(payBody.items)).toBe(true);
    expect(payBody.items).toHaveLength(0);
    expect(Number(payBody.total || 0)).toBe(0);
    expect(Number(payBody.totalAmount || 0)).toBe(0);
    expect(payBody.hasMore).toBe(false);

    const attRes = await api.post(`/api/people/${personId}/attachments`, {
      data: {
        kind: 'FOTO',
        title: 'Pasfoto e2e',
        originalName: 'pasfoto.png',
        dataBase64: PNG_1X1,
      },
    });
    expect(attRes.ok(), `POST attachment ${attRes.status()} ${await attRes.text()}`).toBeTruthy();
    const withAtt = await jsonOf(attRes) as {
      attachments: Array<{ id: string; kind: string; filename?: string; originalName?: string }>;
    };
    const foto = withAtt.attachments.find((a) => a.kind === 'FOTO');
    expect(foto?.id).toBeTruthy();
    expect(foto).not.toHaveProperty('filename');
    attachmentId = foto!.id;

    const dl = await api.get(`/api/people/${personId}/attachments/${attachmentId}`);
    expect(dl.ok()).toBeTruthy();
    expect(dl.headers()['content-type']).toMatch(/image\//);
    expect(dl.headers()['cache-control'] || '').toMatch(/private/i);
    const buf = Buffer.from(await dl.body());
    expect(buf.length).toBeGreaterThan(10);

    const detail = await api.get(`/api/people/${personId}`);
    const detailDoc = await jsonOf(detail) as {
      attachments?: Array<{ filename?: string }>;
      paymentCount?: number;
    };
    expect(JSON.stringify(detailDoc)).not.toContain('filename');
    expect(detailDoc.paymentCount).toBe(0);

    const mediaGuess = await api.get(`/api/media/${tenantId}/kdp-not-a-real-file.png`);
    expect(mediaGuess.status()).toBe(404);

    const deact = await api.delete(`/api/people/${personId}`);
    expect(deact.ok()).toBeTruthy();
    const after = await jsonOf(deact) as { aktif?: boolean };
    expect(after.aktif).toBe(false);
  });

  test('UI: tambah personel, rekening, lampiran, tab transfer kosong, nonaktifkan', async ({ page }) => {
    await login(page);
    await ensureActingTenant(page);

    const uiStamp = `${Date.now()}`.slice(-8);
    const uiNama = `[E2E-PEOPLE] UI ${uiStamp}`;
    const uiNorek = `77${uiStamp}01`;

    await page.goto('/people');
    await expect(page.getByRole('heading', { name: /^Personel$/i })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Tambah Personel/i }).click();
    await expect(page.getByRole('heading', { name: /Tambah Personel/i })).toBeVisible();

    await page.getByPlaceholder('Nama lengkap').fill(uiNama);
    await page.getByRole('tab', { name: /^Rekening$/i }).click();
    await page.getByRole('button', { name: /Tambah rekening/i }).click();
    await page.getByRole('tabpanel').locator('input').first().fill(uiNorek);

    await page.getByRole('button', { name: /^Simpan$/i }).click();
    await expect(page.getByText(/Personel ditambahkan/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /Personel KDP/i })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('tab', { name: /^Lampiran$/i }).click();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'pasfoto.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        PNG_1X1.split(',')[1],
        'base64',
      ),
    });
    await expect(page.getByText(/Lampiran ditambahkan|Pasfoto|Foto/i).first()).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole('tab', { name: /Transfer gaji/i }).click();
    await expect(page.getByText(/Belum ada transfer gaji/i)).toBeVisible({ timeout: 10_000 });

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /Nonaktifkan/i }).click();
    await expect(page.getByText(/Personel dinonaktifkan/i)).toBeVisible({ timeout: 15_000 });
  });
});
