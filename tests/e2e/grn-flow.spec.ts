import { test, expect } from '@playwright/test';

test.describe('Inventory app — public pages', () => {
  test('login page loads', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /inventory/i })).toBeVisible({ timeout: 15_000 });
  });

  test('unauthenticated user redirected from dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/?(\?|$)/, { timeout: 15_000 });
  });

  test('API health responds', async ({ request }) => {
    const res = await request.get('/api/');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.message).toMatch(/ready/i);
  });

  test('API readiness checks database', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
  });
});
