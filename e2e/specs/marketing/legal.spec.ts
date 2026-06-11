import { test, expect } from '@playwright/test';

const MARKETING_URL =
  process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

test.describe('Marketing legal pages', () => {
  test('legal index redirects to impressum', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/legal`);
    await expect(page).toHaveURL(/\/legal\/impressum/);
  });

  test('Impressum page renders legal content', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/legal/impressum`);
    await expect(page.locator('[data-testid="legal-content"]')).toBeVisible();
  });

  test('Datenschutz page is reachable', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/legal/datenschutz`);
    await expect(page.locator('[data-testid="legal-content"]')).toBeVisible();
  });

  test('AGB page is reachable', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/legal/agb`);
    await expect(page.locator('[data-testid="legal-content"]')).toBeVisible();
  });

  test('DE legal pages render content', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/de/legal/impressum`);
    await expect(page.locator('[data-testid="legal-content"]')).toBeVisible();

    await page.goto(`${MARKETING_URL}/de/legal/datenschutz`);
    await expect(page.locator('[data-testid="legal-content"]')).toBeVisible();

    await page.goto(`${MARKETING_URL}/de/legal/agb`);
    await expect(page.locator('[data-testid="legal-content"]')).toBeVisible();
  });

  test('legal tab navigation switches between legal pages', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/legal/datenschutz`);
    await expect(page.locator('[data-testid="legal-content"]')).toBeVisible();

    // Navigate via footer link
    await page.locator('footer a').filter({ hasText: /Impressum|AGB/i }).first().click();
    await expect(page.locator('[data-testid="legal-content"]')).toBeVisible();
  });
});