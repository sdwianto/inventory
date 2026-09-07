import { test, expect, type Page } from '@playwright/test';

/**
 * ADR-008 UX — koreksi harga di Tagihan Vendor (bukan RTV).
 * Prefers E2E_EMAIL / E2E_PASSWORD; falls back to local MASTER used by RTV scripts.
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

  await expect(page).toHaveURL(/\/(dashboard|pembelian-po|hutang)/, { timeout: 25_000 });
}

async function openFirstHutangDetail(page: Page) {
  await page.goto(`/hutang?tenantId=${encodeURIComponent(tenantId)}`);
  await expect(page.getByRole('heading', { name: /Tagihan Vendor/i })).toBeVisible({ timeout: 20_000 });

  // Prefer "Semua" so APPROVED invoices with credit notes are included
  await page.getByRole('button', { name: /^Semua$/i }).click();
  await page.waitForTimeout(800);

  const row = page.locator('tbody tr.cursor-pointer, tbody tr').filter({ hasText: /INV/ }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();

  // Detail dialog / panel
  await expect(page.getByText('Tagihan vendor')).toBeVisible({ timeout: 15_000 });
}

test.describe('Hutang — UX koreksi harga (ADR-008)', () => {
  test('banner, Koreksi harga dialog, Buat Retur (fisik)', async ({ page }) => {
    await login(page);
    await openFirstHutangDetail(page);

    await expect(page.getByText('Salah harga vs retur fisik')).toBeVisible();
    await expect(
      page.getByText(/Credit Note di Sales/i),
    ).toBeVisible();

    const koreksi = page.getByRole('button', { name: /Koreksi harga/i });
    await expect(koreksi).toBeVisible();

    const buatRetur = page.getByRole('link', { name: /Buat Retur/i });
    await expect(buatRetur).toBeVisible();
    await expect(buatRetur).toHaveAttribute('title', /Retur fisik/i);
    await expect(buatRetur).toHaveAttribute('href', /\/retur-vendor\?hutangId=/);

    await koreksi.click();
    await expect(page.getByRole('heading', { name: /Koreksi harga → draft CN \/ DN Sales/i })).toBeVisible();
    await expect(page.getByText(/harga benar/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Buat draft CN$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Buat draft DN$/i })).toBeVisible();

    // Close dialog
    await page.getByRole('button', { name: /^Batal$/i }).click();
    await expect(page.getByRole('heading', { name: /Koreksi harga → draft CN \/ DN Sales/i })).toHaveCount(0);
  });

  test('retur-vendor page points price errors to Sales CN', async ({ page }) => {
    await login(page);
    await page.goto(`/retur-vendor?tenantId=${encodeURIComponent(tenantId)}`);
    await expect(page.getByRole('heading', { name: /Retur Vendor/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Koreksi harga di Tagihan/i)).toBeVisible();
    await expect(page.getByText(/bukan RTV \(ADR-008\)/i)).toBeVisible();
  });

  test('CN finansial label when manual credit notes exist', async ({ page }) => {
    await login(page);
    await openFirstHutangDetail(page);

    const financial = page.getByText('Koreksi harga / CN finansial');
    const rtvLabel = page.getByText(/Retur Inventory/);
    // At least one of the two label styles may appear depending on fixture data;
    // if any CN block exists, financial or RTV label must be present (not old "Manual / webhook").
    const cnBlock = page.getByText(/Credit note \/ retur/i);
    if (await cnBlock.isVisible().catch(() => false)) {
      await expect(page.getByText(/Manual \/ webhook/i)).toHaveCount(0);
      const fin = await financial.count();
      const rtv = await rtvLabel.count();
      expect(fin + rtv).toBeGreaterThan(0);
    }
  });
});
