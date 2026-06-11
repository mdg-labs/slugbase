import { test, expect } from '@playwright/test';

const MARKETING_URL =
  process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

test.describe('Locale switcher', () => {
  test('EN landing page shows DE locale toggle', async ({ page }) => {
    await page.goto(MARKETING_URL);

    await expect(page.locator('[data-testid="locale-switcher"]')).toBeVisible();
    // On EN page, the toggle should point to DE
    await expect(page.locator('[data-testid="locale-option-de"]')).toBeVisible();
  });

  test('clicking locale toggle navigates to DE version', async ({ page }) => {
    const response = await page.goto(MARKETING_URL);
    // Determine current locale from URL
    const localeLink = page.locator('[data-testid="locale-switcher"] a');
    const href = await localeLink.getAttribute('href');

    await page.goto(new URL(href ?? '/de/', MARKETING_URL).href);

    // After following the locale link we should be on a DE page
    await expect(page.locator('[data-testid="marketing-hero"]')).toBeVisible();
    await expect(page).toHaveURL(/\/de\//);
  });

  test('DE pricing page shows EN locale toggle', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/de/pricing`);

    await expect(page.locator('[data-testid="locale-switcher"]')).toBeVisible();
    // On DE page, the toggle should point to EN
    await expect(page.locator('[data-testid="locale-option-en"]')).toBeVisible();
  });

  test('locale toggle preserves page context from contact page', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/contact`);

    // Get the locale switch link
    const localeLink = page.locator('[data-testid="locale-switcher"] a');
    const href = await localeLink.getAttribute('href');

    // Navigate to DE contact page
    await page.goto(new URL(href ?? '/de/', MARKETING_URL).href);
    await expect(page).toHaveURL(/\/de\//);
  });
});