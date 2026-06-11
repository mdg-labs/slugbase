import { test, expect } from '@playwright/test';

const MARKETING_URL =
  process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

test.describe('Marketing CTA links', () => {
  test('Sign In nav link points to /login', async ({ page }) => {
    await page.goto(MARKETING_URL);
    await page.waitForSelector('[data-testid="marketing-nav-signin"]');

    await page.click('[data-testid="marketing-nav-signin"]');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('Get Started nav link points to /register', async ({ page }) => {
    await page.goto(MARKETING_URL);
    await page.waitForSelector('[data-testid="marketing-nav-getstarted"]');

    await page.click('[data-testid="marketing-nav-getstarted"]');
    await expect(page).toHaveURL(/\/register$/);
  });

  test('Hero CTA points to /register', async ({ page }) => {
    await page.goto(MARKETING_URL);
    await page.waitForSelector('[data-testid="marketing-hero-cta"]');

    await page.click('[data-testid="marketing-hero-cta"]');
    await expect(page).toHaveURL(/\/register$/);
  });
});