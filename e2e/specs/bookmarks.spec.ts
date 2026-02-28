/**
 * Bookmarks flow e2e: open bookmarks, create a bookmark, verify it appears.
 * Uses authenticated storage state from auth.setup.ts.
 */
import { test, expect } from '@playwright/test';

test.describe('Bookmarks', () => {
  test('opens bookmarks page and creates a new bookmark', async ({ page }) => {
    await page.goto('/bookmarks');

    await expect(page.getByRole('heading', { name: /bookmarks/i })).toBeVisible({ timeout: 10000 });

    const createButton = page.getByRole('button', { name: /create bookmark/i });
    await createButton.click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    const title = `E2E Bookmark ${Date.now()}`;
    const url = 'https://example.com/e2e-test';

    await page.getByLabel(/title/i).fill(title);
    await page.getByLabel(/^url$/i).fill(url);
    await page.getByRole('button', { name: /save/i }).click();

    await expect(modal).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(title)).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('link', { name: new RegExp(title) }).or(page.getByText(url))).toBeVisible();
  });
});
