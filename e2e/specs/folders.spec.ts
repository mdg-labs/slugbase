/**
 * Folders: create a folder and verify it appears in the list.
 */
import { test, expect } from '@playwright/test';

test.describe('Folders', () => {
  test('creates a new folder', async ({ page }) => {
    await page.goto('/folders');

    await expect(
      page.getByRole('heading', { level: 1, name: /^Folders/ })
    ).toBeVisible({ timeout: 10000 });

    const createButton = page
      .getByRole('main')
      .getByRole('button', { name: /create folder/i })
      .first();
    await createButton.click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    const folderName = `E2E Folder ${Date.now()}`;
    await modal.getByRole('textbox', { name: 'Name', exact: true }).fill(folderName);
    await modal.getByRole('button', { name: /save/i }).click();

    await expect(modal).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(folderName)).toBeVisible({ timeout: 5000 });
  });
});
