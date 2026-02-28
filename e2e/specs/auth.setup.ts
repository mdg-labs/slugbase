/**
 * Runs once before other tests. Logs in and saves storage state for authenticated tests.
 * Depends on global setup having seeded the test user (e2e@test.local) via seed script.
 */
import { test as setup, expect } from '@playwright/test';

const authFile = 'e2e/.auth/user.json';

setup('authenticate', async ({ page }) => {
  const email = process.env.E2E_TEST_USER_EMAIL || 'e2e@test.local';
  const password = process.env.E2E_TEST_USER_PASSWORD || 'TestPassword123!';

  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /log in|login/i }).click();

  await expect(page).not.toHaveURL(/\/login/);
  await page.context().storageState({ path: authFile });
});
