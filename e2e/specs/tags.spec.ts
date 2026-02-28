/**
 * Tags: create a tag and verify it appears in the list.
 */
import { test, expect } from '@playwright/test';

test.describe('Tags', () => {
  test('creates a new tag', async ({ page }) => {
    await page.goto('/tags');

    await expect(
      page.getByRole('heading', { level: 1, name: /^Tags/ })
    ).toBeVisible({ timeout: 10000 });

    const createButton = page.getByRole('main').getByRole('button', {
      name: /create tag/i,
    });
    await createButton.click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    const tagName = `e2e-tag-${Date.now()}`;
    await modal.getByPlaceholder(/name/i).fill(tagName);
    await modal.getByRole('button', { name: /save/i }).click();

    await expect(modal).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(tagName)).toBeVisible({ timeout: 5000 });
  });
});
