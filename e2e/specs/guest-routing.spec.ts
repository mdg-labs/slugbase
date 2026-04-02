/**
 * Guest routing: private app routes redirect to login without storage state.
 */
import { test, expect } from '@playwright/test';

test.describe('Guest routing', () => {
  test('redirects /bookmarks to login when not signed in', async ({ page }) => {
    await page.goto('/bookmarks');

    await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
  });
});
