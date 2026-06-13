import { test, expect } from '@playwright/test';

test.describe('Unauthenticated guards', () => {
  test('visiting /bookmarks without session redirects to /login', async ({ page }) => {
    await page.goto('/bookmarks');
    await page.waitForURL(/\/login/);
    expect(page.url()).toContain('/login');
  });

  test('visiting /settings without session redirects to /login', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForURL(/\/login/);
    expect(page.url()).toContain('/login');
  });
});