import { test, expect } from '@playwright/test';

const MARKETING_URL =
  process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

test.describe('Marketing pricing page', () => {
  test('pricing page renders pricing table with config-driven plans', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/pricing`);

    await expect(page.locator('[data-testid="pricing-table"]')).toBeVisible();
    await expect(page.locator('[data-testid="pricing-plan-free"]')).toBeVisible();
    await expect(page.locator('[data-testid="pricing-plan-personal"]')).toBeVisible();
    await expect(page.locator('[data-testid="pricing-plan-team"]')).toBeVisible();
  });

  test('pricing page renders FAQ section', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/pricing`);

    await expect(page.locator('[data-testid="pricing-faq"]')).toBeVisible();
  });

  test('pricing page renders supporter section when active', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/pricing`);

    // Supporter section may or may not be present depending on config
    const supporter = page.locator('[data-testid="pricing-plan-supporter"]');
    if (await supporter.count() > 0) {
      await expect(supporter).toBeVisible();
    }
  });

  test('DE pricing page renders pricing table', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/de/pricing`);

    await expect(page.locator('[data-testid="pricing-table"]')).toBeVisible();
    await expect(page.locator('[data-testid="pricing-plan-free"]')).toBeVisible();
    await expect(page.locator('[data-testid="pricing-plan-personal"]')).toBeVisible();
    await expect(page.locator('[data-testid="pricing-plan-team"]')).toBeVisible();
    await expect(page.locator('[data-testid="pricing-faq"]')).toBeVisible();
  });
});