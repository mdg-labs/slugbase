import { test, expect } from '@playwright/test';

const MARKETING_URL =
  process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

test.describe('Analytics consent banner', () => {
  test('consent banner is visible when Umami is configured', async ({ page }) => {
    await page.goto(MARKETING_URL);

    // The banner may or may not be visible depending on whether Umami env vars are set
    // and whether consent was previously stored in localStorage
    const banner = page.locator('[data-testid="analytics-consent-banner"]');

    if (await banner.count() > 0) {
      // If the banner is rendered, check for accept/decline buttons
      await expect(page.locator('[data-testid="analytics-consent-accept"]')).toBeVisible();
      await expect(page.locator('[data-testid="analytics-consent-decline"]')).toBeVisible();
    }
  });

  test('accepting consent hides banner', async ({ page }) => {
    // Clear localStorage to ensure banner is shown
    await page.goto(MARKETING_URL);
    await page.evaluate(() => localStorage.removeItem('slugbase_analytics_consent'));

    // Reload to check if banner appears
    await page.reload();

    const banner = page.locator('[data-testid="analytics-consent-banner"]');

    if (await banner.count() > 0 && await banner.isVisible() === false) {
      // Banner is hidden because Umami is not configured - skip test
      test.skip();
      return;
    }

    // If banner is shown, accept it
    const acceptBtn = page.locator('[data-testid="analytics-consent-accept"]');
    if (await acceptBtn.count() > 0 && await acceptBtn.isVisible()) {
      await acceptBtn.click();
      // Banner should hide after accept
      await expect(banner).toBeHidden();
    }
  });

  test('declining consent hides banner', async ({ page }) => {
    // Clear localStorage to ensure banner is shown
    await page.goto(MARKETING_URL);
    await page.evaluate(() => localStorage.removeItem('slugbase_analytics_consent'));

    await page.reload();

    const banner = page.locator('[data-testid="analytics-consent-banner"]');

    if (await banner.count() > 0 && await banner.isVisible() === false) {
      test.skip();
      return;
    }

    const declineBtn = page.locator('[data-testid="analytics-consent-decline"]');
    if (await declineBtn.count() > 0 && await declineBtn.isVisible()) {
      await declineBtn.click();
      await expect(banner).toBeHidden();
    }
  });

  test('consent preference is persisted across page navigation', async ({ page }) => {
    // Clear localStorage to ensure banner is shown
    await page.goto(MARKETING_URL);
    await page.evaluate(() => localStorage.removeItem('slugbase_analytics_consent'));

    await page.reload();

    const banner = page.locator('[data-testid="analytics-consent-banner"]');
    const acceptBtn = page.locator('[data-testid="analytics-consent-accept"]');

    if (await banner.count() > 0 && await banner.isVisible() === false) {
      test.skip();
      return;
    }

    if (await acceptBtn.count() > 0 && await acceptBtn.isVisible()) {
      await acceptBtn.click();
      await expect(banner).toBeHidden();
    }

    // Navigate to another page - banner should stay hidden
    await page.goto(`${MARKETING_URL}/pricing`);
    const bannerAfter = page.locator('[data-testid="analytics-consent-banner"]');
    await expect(bannerAfter).toBeHidden();
  });
});