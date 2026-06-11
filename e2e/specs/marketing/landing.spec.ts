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

  test('hero CTA links to register', async ({ page }) => {
    await page.goto(MARKETING_URL);
    const href = await page.locator('[data-testid="marketing-hero-cta"]').getAttribute('href');
    expect(href).toContain('/register');
  });

  test('sign in nav link points to login', async ({ page }) => {
    await page.goto(MARKETING_URL);
    const href = await page.locator('[data-testid="marketing-nav-signin"]').getAttribute('href');
    expect(href).toContain('/login');
  });

  test('get started nav link points to register', async ({ page }) => {
    await page.goto(MARKETING_URL);
    const href = await page.locator('[data-testid="marketing-nav-getstarted"]').getAttribute('href');
    expect(href).toContain('/register');
  });

  test('DE landing page renders hero, nav, and footer', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/de/`);

    await expect(page.locator('[data-testid="marketing-hero"]')).toBeVisible();
    await expect(page.locator('[data-testid="marketing-nav"]')).toBeVisible();
    await expect(page.locator('[data-testid="marketing-footer"]')).toBeVisible();
  });
});