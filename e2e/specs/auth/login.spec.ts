import { test } from '../../fixtures/auth.js';
import { getWorkerCredentials } from '../../fixtures/auth.js';

test.describe('Login flow', () => {
  test('user can log in via the login form and reach the dashboard', async ({ page }, testInfo) => {
    const { email, password } = getWorkerCredentials(testInfo.workerIndex);

    // Navigate to the login page
    await page.goto('/login');

    // Verify the form is visible
    await page.waitForSelector('[data-testid="login-form"]');

    // Fill in worker-scoped credentials
    await page.fill('[data-testid="login-email-input"]', email);
    await page.fill('[data-testid="login-password-input"]', password);

    // Submit
    await page.click('[data-testid="login-submit-btn"]');

    // Wait for redirect to dashboard (home page)
    await page.waitForURL(/\/$/);

    // Verify sidebar nav is present (dashboard renders after login)
    await page.waitForSelector('[data-testid="sidebar-nav"]');
  });
});