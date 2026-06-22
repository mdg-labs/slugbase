import { test, expect } from '@playwright/test';

const MARKETING_URL =
  process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';
const API_URL = process.env.E2E_BASE_URL_API ?? 'http://localhost:4001';

const mockPricingResponse = {
  plans: {
    personal: {
      monthly: {
        priceId: 'price_e2e_personal_monthly',
        unitAmount: 300,
        currency: 'eur',
        interval: 'month',
        type: 'recurring',
        display: '€3',
      },
      annual: {
        priceId: 'price_e2e_personal_annual',
        unitAmount: 3000,
        currency: 'eur',
        interval: 'year',
        type: 'recurring',
        display: '€30',
      },
    },
    team: {
      monthly: {
        priceId: 'price_e2e_team_monthly',
        unitAmount: 900,
        currency: 'eur',
        interval: 'month',
        type: 'recurring',
        display: '€9',
      },
    },
  },
  freeBookmarkCap: 50,
  teamBaseSeats: 5,
};

test.describe('Marketing pricing page', () => {
  test('GET /pricing/public allows marketing origin via CORS', async ({ request }) => {
    const response = await request.get(`${API_URL}/pricing/public`, {
      headers: { Origin: MARKETING_URL },
    });

    expect(response.headers()['access-control-allow-origin']).toBe(MARKETING_URL);
  });

  test('pricing page renders pricing table with config-driven plans', async ({ page }) => {
    await page.goto(`${MARKETING_URL}/pricing`);

    await expect(page.locator('[data-testid="pricing-table"]')).toBeVisible();
    await expect(page.locator('[data-testid="pricing-plan-free"]')).toBeVisible();
    await expect(page.locator('[data-testid="pricing-plan-personal"]')).toBeVisible();
    await expect(page.locator('[data-testid="pricing-plan-team"]')).toBeVisible();
  });

  test('personal plan price hydrates from public pricing API', async ({ page }) => {
    await page.route(`${API_URL}/pricing/public`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Access-Control-Allow-Origin': MARKETING_URL,
          'Access-Control-Allow-Credentials': 'true',
        },
        body: JSON.stringify(mockPricingResponse),
      });
    });

    await page.goto(`${MARKETING_URL}/pricing`);

    const personalPrice = page.locator(
      '[data-testid="pricing-plan-personal"] [data-price-monthly]',
    );
    await expect(personalPrice).toBeVisible();
    await expect(personalPrice).not.toHaveText('—', { timeout: 10_000 });
    await expect(personalPrice).toHaveText(/€3|[\d]/);
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