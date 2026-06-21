import { test, expect } from '@playwright/test';

const WEB_URL = process.env.E2E_BASE_URL_WEB ?? process.env.E2E_BASE_URL_CE ?? 'http://localhost:4002';
const MARKETING_URL = process.env.E2E_BASE_URL_MARKETING;
const API_URL = process.env.E2E_BASE_URL_API ?? process.env.E2E_BASE_URL_CE ?? 'http://localhost:4001';

test.describe('Health + version smoke', () => {
  test('web /health returns 200 JSON', async ({ page }) => {
    const res = await page.request.get(`${WEB_URL}/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('status', 'ok');
  });

  test('web /version returns 200 JSON with version string', async ({ page }) => {
    const res = await page.request.get(`${WEB_URL}/version`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('version');
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  test('marketing root returns 200', async ({ page }) => {
    test.skip(!MARKETING_URL, 'Marketing site not available in CE mode');
    const res = await page.request.get(MARKETING_URL!);
    expect(res.ok()).toBeTruthy();
  });

  test('API /health returns 200', async ({ page }) => {
    const res = await page.request.get(`${API_URL}/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('status', 'ok');
  });
});
