/**
 * Login flow e2e: unauthenticated user can open login and sign in with email/password.
 * Uses UI only (no storage state) to exercise the full login path.
 */
import { test, expect } from '@playwright/test';

test.describe('Login', () => {
  test('shows login page and signs in with email and password', async ({ page }) => {
    await page.goto('/login');

    await expect(
      page.getByRole('heading', { name: /welcome back|log in|login/i })
    ).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();

    const email = process.env.E2E_TEST_USER_EMAIL || 'e2e@test.local';
    const password = process.env.E2E_TEST_USER_PASSWORD || 'TestPassword123!';

    await page.getByLabel(/email/i).fill(email);
    // Use id so we target the login form only (works in all locales)
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: /sign in|log in|login/i }).click();

    await expect(page).not.toHaveURL(/\/login/);
    // Sidebar + dashboard can both expose a /bookmarks link; avoid strict-mode duplicate match.
    await expect(page.getByRole('link', { name: /^Bookmarks$/i }).first()).toBeVisible({ timeout: 10000 });
  });
});
