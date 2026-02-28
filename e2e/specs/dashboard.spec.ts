/**
 * Dashboard smoke: authenticated user sees the dashboard.
 */
import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test('loads dashboard when authenticated', async ({ page }) => {
    await page.goto('/');

    await expect(
      page.getByRole('heading', { level: 1 }).or(page.getByRole('main'))
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('link', { name: /bookmarks/i })).toBeVisible();
  });
});
