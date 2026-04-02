/**
 * Profile: authenticated user can open profile and see account summary.
 */
import { test, expect } from '@playwright/test';

test.describe('Profile', () => {
  test('loads profile with signed-in email', async ({ page }) => {
    await page.goto('/profile');

    await expect(page.getByRole('heading', { level: 1, name: /^Profile$/i })).toBeVisible({
      timeout: 10000,
    });

    const email = process.env.E2E_TEST_USER_EMAIL || 'e2e@test.local';
    await expect(page.getByText(email, { exact: true }).first()).toBeVisible();
  });
});
