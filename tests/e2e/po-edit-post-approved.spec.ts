import { test, expect, type Page } from '@playwright/test';

/**
 * Edit PO in-place setelah APPROVED/SUBMITTED/CONFIRMED (noPO tetap).
 * Prefers E2E_* env; fallback MASTER lokal.
 */
const email = process.env.E2E_EMAIL || process.env.E2E_MASTER_EMAIL || 'dawam@master.com';
const password = process.env.E2E_PASSWORD || process.env.E2E_MASTER_PASSWORD || 'dawam123';
const tenantId = process.env.E2E_TENANT || 'sppg';

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

  await expect(page).toHaveURL(/\/(dashboard|pembelian-po)/, { timeout: 25_000 });
}

async function gotoPembelianPo(page: Page) {
  await page.goto(`/pembelian-po?tenantId=${encodeURIComponent(tenantId)}`);
  await expect(page.getByRole('heading', { name: /PO ke Vendor/i })).toBeVisible({ timeout: 20_000 });
}

/** Kartu PO yang punya tombol Edit dan badge status pasca-approve. */
function postApprovedEditableCard(page: Page) {
  return page
    .locator('[class*="rounded"]')
    .filter({ has: page.getByRole('button', { name: /^Edit$/i }) })
    .filter({ hasText: /APPROVED|SUBMITTED|CONFIRMED/ })
    .first();
}

test.describe('Pembelian PO — edit pasca-approve (UI)', () => {
  test('halaman PO + tombol Edit muncul pada PO yang boleh diedit', async ({ page }) => {
    await login(page);
    await gotoPembelianPo(page);

    // Pastikan filter status tidak menyembunyikan post-approve
    const semua = page.getByRole('button', { name: /semua status|pilih semua/i });
    if (await semua.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await semua.click();
    }

    const anyEdit = page.getByRole('button', { name: /^Edit$/i }).first();
    await expect(anyEdit).toBeVisible({ timeout: 20_000 });
  });

  test('buka form edit post-approve: alasan wajib + simpan disabled tanpa alasan', async ({ page }) => {
    await login(page);
    await gotoPembelianPo(page);

    const card = postApprovedEditableCard(page);
    const hasPostApproved = await card.isVisible({ timeout: 12_000 }).catch(() => false);
    test.skip(!hasPostApproved, 'Tidak ada PO APPROVED/SUBMITTED/CONFIRMED yang bisa diedit di tenant ini');

    const noPoText = await card.locator('text=/CPO\\d+|PO\\s*\\d+/i').first().textContent().catch(() => null);
    await card.getByRole('button', { name: /^Edit$/i }).click();

    await expect(page.getByRole('heading', { name: /Edit PO/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/nomor PO tetap|noPO tetap/i)).toBeVisible();
    await expect(page.getByLabel(/Alasan edit/i)).toBeVisible();

    const saveBtn = page.getByRole('button', { name: /Simpan & Sync Vendor|Simpan Perubahan/i });
    await expect(saveBtn).toBeDisabled();

    await page.getByLabel(/Alasan edit/i).fill('E2E koreksi qty uji UI');
    await expect(saveBtn).toBeEnabled({ timeout: 3_000 });

    // Pastikan form item penuh (bukan hanya catatan)
    await expect(page.getByRole('button', { name: /Tambah baris/i })).toBeVisible();
    await expect(page.getByText(/Detail barang/i)).toBeVisible();

    if (noPoText) {
      await expect(page.getByRole('heading', { name: new RegExp(noPoText.trim().slice(0, 20), 'i') })).toBeVisible();
    }

    // Tutup tanpa simpan — dismiss tanpa alasan cukup pendek sudah diisi; pakai Batal
    await page.getByRole('button', { name: /^Batal$/i }).click();
    await expect(page.getByRole('heading', { name: /Edit PO/i })).toHaveCount(0);
  });

  test('ubah qty + simpan edit post-approve (noPO tetap)', async ({ page }) => {
    await login(page);
    await gotoPembelianPo(page);

    const card = postApprovedEditableCard(page);
    const hasPostApproved = await card.isVisible({ timeout: 12_000 }).catch(() => false);
    test.skip(!hasPostApproved, 'Tidak ada PO APPROVED/SUBMITTED/CONFIRMED yang bisa diedit di tenant ini');

    const headingBefore = await card.locator('h3, h2, .font-mono, [class*="font-mono"]').first().textContent().catch(() => '');
    await card.getByRole('button', { name: /^Edit$/i }).click();
    await expect(page.getByRole('heading', { name: /Edit PO/i })).toBeVisible({ timeout: 10_000 });

    const dialogTitle = await page.getByRole('heading', { name: /Edit PO/i }).textContent();
    const noPoMatch = dialogTitle?.match(/Edit PO\s+(.+)/i);
    const noPo = noPoMatch?.[1]?.trim() || '';

    await page.getByLabel(/Alasan edit/i).fill('E2E ubah qty pasca-approve');

    // Ubah qty baris pertama yang terlihat
    const qtyInput = page.locator('input[type="number"], input').filter({ hasNot: page.locator('[type="date"]') }).nth(0);
    // Cari input qty di grid baris — biasanya di kolom Qty
    const qtyInRow = page.getByRole('dialog').locator('input').filter({ has: page.locator('xpath=ancestor::*[contains(@class,"grid") or contains(@class,"border")]') });
    const qtyCandidates = page.getByRole('dialog').locator('input:not([type="date"]):not([type="hidden"])');
    const count = await qtyCandidates.count();
    let changed = false;
    for (let i = 0; i < count; i += 1) {
      const el = qtyCandidates.nth(i);
      const val = await el.inputValue().catch(() => '');
      if (/^\d+(\.\d+)?$/.test(val.trim()) && Number(val) > 0) {
        const next = String(Number(val) + 1);
        await el.fill(next);
        changed = true;
        break;
      }
    }
    expect(changed, 'Harus menemukan input qty numerik di form').toBeTruthy();

    const saveBtn = page.getByRole('button', { name: /Simpan & Sync Vendor/i });
    await expect(saveBtn).toBeEnabled();

    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/customer-purchase-orders/')
          && r.request().method() === 'PUT'
          && r.status() < 500,
        { timeout: 60_000 },
      ),
      saveBtn.click(),
    ]);

    expect(resp.status(), `PUT status ${resp.status()}`).toBeLessThan(400);
    const body = await resp.json().catch(() => ({} as Record<string, unknown>));
    if (noPo) {
      expect(String(body.noPO || '')).toBe(noPo);
    }
    expect(['APPROVED', 'SUBMITTED', 'CONFIRMED']).toContain(String(body.status || ''));

    await expect(page.getByRole('heading', { name: /Edit PO/i })).toHaveCount(0, { timeout: 15_000 });
    // Toast sukses / warning sync
    await expect(
      page.getByText(/diperbarui|disimpan|sync vendor/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    void headingBefore;
  });
});
