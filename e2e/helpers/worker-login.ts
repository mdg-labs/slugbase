import type { Page } from '@playwright/test';
import { getWorkerCredentials } from '../fixtures/auth.js';

/**
 * Perform a form-based login using worker-scoped credentials.
 *
 * Use this in tests that manually fill the login form instead of using the
 * `authedPage` / `sessionCookie` fixtures. This ensures each Playwright
 * worker operates on a unique user, preventing cross-worker test pollution.
 *
 * @example
 * test("my test", async ({ page }, testInfo) => {
 *   await loginAsWorker(page, testInfo.workerIndex);
 *   // ... test body
 * });
 */
export async function loginAsWorker(page: Page, workerIndex: number): Promise<void> {
  const { email, password } = getWorkerCredentials(workerIndex);

  await page.goto('/login');
  await page.waitForSelector('[data-testid="login-form"]');
  await page.fill('[data-testid="login-email-input"]', email);
  await page.fill('[data-testid="login-password-input"]', password);
  await page.click('[data-testid="login-submit-btn"]');
  await page.waitForURL(/\/$/);
  await page.waitForSelector('[data-testid="sidebar-nav"]');
}
