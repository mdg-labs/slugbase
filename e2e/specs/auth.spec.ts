/**
 * Login flow e2e: unauthenticated user can open login and sign in with email/password.
 * Uses UI only (no storage state) to exercise the full login path.
 */
import { test, expect } from '@playwright/test';

test.describe('Login', () => {
  test('shows login page and signs in with email and password', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('heading', { name: /log in|login/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();

    const email = process.env.E2E_TEST_USER_EMAIL || 'e2e@test.local';
    const password = process.env.E2E_TEST_USER_PASSWORD || 'TestPassword123!';

    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /log in|login/i }).click();

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole('link', { name: /bookmarks/i })).toBeVisible({ timeout: 10000 });
  });
});
