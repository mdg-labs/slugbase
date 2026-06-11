import { test, expect } from '@playwright/test';

const MARKETING_URL =
  process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

test.describe('Marketing landing page', () => {
  test('EN landing page renders hero, nav, and footer', async ({ page }) => {
    await page.goto(MARKETING_URL);

    await expect(page.locator('[data-testid="marketing-hero"]')).toBeVisible();
    await expect(page.locator('[data-testid="marketing-nav"]')).toBeVisible();
    await expect(page.locator('[data-testid="marketing-footer"]')).toBeVisible();
  });

  test('hero CTA navigates to register', async ({ page }) => {
    await page.goto(MARKETING_URL);
    await page.locator('[data-testid="marketing-hero-cta"]').click();
    await expect(page).toHaveURL(/\/register$/);
  });

  test('sign in nav link navigates to login', async ({ page }) => {
    await page.goto(MARKETING_URL);
    await page.locator('[data-testid="marketing-nav-signin"]').click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('get started nav link navigates to register', async ({ page }) => {
    await page.goto(MARKETING_URL);
    await page.locator('[data-testid="marketing-nav-getstarted"]').click();
    await expect(page).toHaveURL(/\/register$/);
  });

  test('DE landing page renders hero, nav, and footer', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/de/`);

    await expect(page.locator('[data-testid="marketing-hero"]')).toBeVisible();
    await expect(page.locator('[data-testid="marketing-nav"]')).toBeVisible();
    await expect(page.locator('[data-testid="marketing-footer"]')).toBeVisible();
  });
});