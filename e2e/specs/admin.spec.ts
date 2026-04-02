/**
 * Admin: self-hosted redirects /admin to members; OIDC settings page loads.
 */
import { test, expect } from '@playwright/test';

test.describe('Admin', () => {
  test('redirects /admin to members and shows users table header', async ({ page }) => {
    await page.goto('/admin');

    await expect(page).toHaveURL(/\/admin\/members/, { timeout: 10000 });
    await expect(page.getByRole('heading', { level: 1, name: /^Users$/i })).toBeVisible({
      timeout: 10000,
    });
  });

  test('loads OIDC providers admin page', async ({ page }) => {
    await page.goto('/admin/oidc');

    await expect(page.getByRole('heading', { level: 1, name: /OIDC Providers/i })).toBeVisible({
      timeout: 10000,
    });
  });
});
