import { test, expect } from '@playwright/test';

const MARKETING_URL =
  process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

test.describe('Marketing CTA links', () => {
  test('Sign In nav link has href pointing to /login', async ({ page }) => {
    await page.goto(MARKETING_URL);
    await page.waitForSelector('[data-testid="marketing-nav-signin"]');

    const href = await page.locator('[data-testid="marketing-nav-signin"]').getAttribute('href');
    expect(href).toContain('/login');
  });

  test('Get Started nav link has href pointing to /register', async ({ page }) => {
    await page.goto(MARKETING_URL);
    await page.waitForSelector('[data-testid="marketing-nav-getstarted"]');

    const href = await page.locator('[data-testid="marketing-nav-getstarted"]').getAttribute('href');
    expect(href).toContain('/register');
  });

  test('Hero CTA has href pointing to /register', async ({ page }) => {
    await page.goto(MARKETING_URL);
    await page.waitForSelector('[data-testid="marketing-hero-cta"]');

    const href = await page.locator('[data-testid="marketing-hero-cta"]').getAttribute('href');
    expect(href).toContain('/register');
  });
});
