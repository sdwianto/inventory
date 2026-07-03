import { test, expect, type Page } from '@playwright/test';

const masterEmail = process.env.E2E_MASTER_EMAIL || 'master@dawam.com';
const masterPassword = process.env.E2E_MASTER_PASSWORD || 'master123';

async function loginAsMaster(page: Page) {
  await page.goto('/');
  await page.getByLabel(/^email$/i).fill(masterEmail);
  await page.getByLabel(/^password$/i).fill(masterPassword);
  await page.getByRole('button', { name: /masuk/i }).click();

  const tenantSelect = page.locator('#tenant');
  if (await tenantSelect.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const firstOption = tenantSelect.locator('option:not([value=""])').first();
    const value = await firstOption.getAttribute('value');
    if (value) await tenantSelect.selectOption(value);
    await page.getByRole('button', { name: /masuk/i }).click();
  }

  await expect(page).toHaveURL(/\/(dashboard|pembelian-po)/, { timeout: 25_000 });
}

test.describe('Procurement PO — happy path smoke', () => {
  test('login → halaman pembelian PO dapat diakses', async ({ page }) => {
    await loginAsMaster(page);
    await page.goto('/pembelian-po');
    await expect(page.getByRole('heading', { name: /PO ke Vendor/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('API health + worker backlog terbaca', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.checks?.database).toBe('ok');
    expect(body.checks?.worker).toBeDefined();
    expect(typeof body.checks.worker.pendingCount).toBe('number');
  });
});
