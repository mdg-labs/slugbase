import { test, expect } from '@playwright/test';

const MARKETING_URL =
  process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

test.describe('Marketing error pages', () => {
  test('404 page renders accessible error UI', async ({ page }) => {
    const response = await page.goto(`${MARKETING_URL}/404`);

    // The marketing site's 404 is handled by Astro's static build
    // If the dev server returns 404, just check the content
    await expect(page.locator('[data-testid="error-page-404"]')).toBeVisible();
  });

  test('500 page renders accessible error UI', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/500`);

    await expect(page.locator('[data-testid="error-page-500"]')).toBeVisible();
  });

  test('DE 404 page renders accessible error UI', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/de/404`);

    await expect(page.locator('[data-testid="error-page-404"]')).toBeVisible();
  });

  test('DE 500 page renders accessible error UI', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/de/500`);

    await expect(page.locator('[data-testid="error-page-500"]')).toBeVisible();
  });
});