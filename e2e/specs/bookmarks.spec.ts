/**
 * Bookmarks flow e2e: open bookmarks, create a bookmark, verify it appears.
 * Uses authenticated storage state from auth.setup.ts.
 */
import { test, expect } from '@playwright/test';

test.describe('Bookmarks', () => {
  test('opens bookmarks page and creates a new bookmark', async ({ page }) => {
    await page.goto('/bookmarks');

    await expect(page.getByRole('heading', { level: 1, name: /^Bookmarks/ })).toBeVisible({ timeout: 10000 });

    const createButton = page.getByRole('main').getByRole('button', { name: /create bookmark/i });
    await createButton.click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    const title = `E2E Bookmark ${Date.now()}`;
    const url = 'https://example.com/e2e-test';

    // Form fields use placeholders "Title" / "URL"; labels are not wired with htmlFor so use placeholder or role within dialog
    await modal.getByPlaceholder(/title/i).fill(title);
    await modal.getByPlaceholder(/^url$/i).fill(url);
    await modal.getByRole('button', { name: /save/i }).click();

    await expect(modal).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(title)).toBeVisible({ timeout: 5000 });
  });

  test('edits a bookmark title from the table row menu', async ({ page }) => {
    await page.goto('/bookmarks?view=table');

    await expect(page.getByRole('heading', { level: 1, name: /^Bookmarks/ })).toBeVisible({ timeout: 10000 });

    const initialTitle = `E2E Edit Before ${Date.now()}`;
    const url = 'https://example.com/e2e-edit';

    await page.getByRole('main').getByRole('button', { name: /create bookmark/i }).click();
    const createModal = page.getByRole('dialog');
    await expect(createModal).toBeVisible();
    await createModal.getByPlaceholder(/title/i).fill(initialTitle);
    await createModal.getByPlaceholder(/^url$/i).fill(url);
    await createModal.getByRole('button', { name: /save/i }).click();
    await expect(createModal).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('row').filter({ hasText: initialTitle }).first()).toBeVisible({
      timeout: 5000,
    });

    const row = page.getByRole('row').filter({ hasText: initialTitle }).first();
    await row.getByRole('button', { name: /more actions/i }).click({ force: true });
    await page.getByRole('menuitem', { name: /^Edit$/i }).click();

    const editModal = page.getByRole('dialog');
    await expect(editModal).toBeVisible({ timeout: 5000 });

    const newTitle = `E2E Edit After ${Date.now()}`;
    const titleInput = editModal.getByPlaceholder(/title/i);
    await titleInput.clear();
    await titleInput.fill(newTitle);
    await editModal.getByRole('button', { name: /save/i }).click();

    await expect(editModal).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(newTitle, { exact: true }).first()).toBeVisible({ timeout: 5000 });
  });
});
