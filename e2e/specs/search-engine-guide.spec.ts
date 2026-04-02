/**
 * Search engine guide: static help page loads.
 */
import { test, expect } from '@playwright/test';

test.describe('Search engine guide', () => {
  test('loads custom search engine setup guide', async ({ page }) => {
    await page.goto('/search-engine-guide');

    await expect(
      page.getByRole('heading', { level: 1, name: /Custom Search Engine Setup Guide/i })
    ).toBeVisible({ timeout: 10000 });
  });
});
