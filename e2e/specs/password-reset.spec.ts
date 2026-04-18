/**
 * Password reset request: unauthenticated user submits email; generic success message (no leak).
 */
import { test, expect } from '@playwright/test';

test.describe('Password reset', () => {
  test('request step shows success after submit', async ({ page }) => {
    await page.goto('/password-reset');

    await expect(
      page.getByRole('heading', { name: /reset your password|reset password/i })
    ).toBeVisible();

    await page.getByLabel(/^email$/i).fill('nobody@example.com');
    await page.getByRole('button', { name: /send reset link/i }).click();

    await expect(page.getByText(/password reset link has been sent/i)).toBeVisible({
      timeout: 10000,
    });
  });
});
