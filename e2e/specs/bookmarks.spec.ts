/**
 * Bookmarks flow e2e: open bookmarks, create a bookmark, verify it appears.
 * Uses authenticated storage state from auth.setup.ts.
 */
import { test, expect } from '@playwright/test';

test.describe('Bookmarks', () => {
  test('opens bookmarks page and creates a new bookmark', async ({ page }) => {
    await page.goto('/bookmarks?view=table');

    await expect(page.getByRole('heading', { level: 1, name: /^Bookmarks/ })).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: /create bookmark/i }).first().click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    const title = `E2E Bookmark ${Date.now()}`;
    const url = 'https://example.com/e2e-test';

    // Bookmark modal: URL field uses placeholder "https://"; title uses i18n "Title"
    await modal.getByPlaceholder(/^https/i).fill(url);
    await modal.getByPlaceholder(/^Title$/i).fill(title);

    const createPost = page.waitForResponse((res) => {
      if (res.request().method() !== 'POST' || res.status() >= 400) return false;
      try {
        return new URL(res.url()).pathname === '/api/bookmarks';
      } catch {
        return false;
      }
    });
    await modal.getByRole('button', { name: /save/i }).click();
    await createPost;

    await expect(modal).not.toBeVisible({ timeout: 10000 });
    // Remount list so heading count + rows reflect the new bookmark (avoids stale UI after modal close).
    await page.goto('/bookmarks?view=table');
    await expect(page.getByRole('row').filter({ hasText: title }).first()).toBeVisible({ timeout: 15000 });
  });

  test('edits a bookmark title from the table row menu', async ({ page }) => {
    await page.goto('/bookmarks?view=table');

    await expect(page.getByRole('heading', { level: 1, name: /^Bookmarks/ })).toBeVisible({ timeout: 10000 });

    const initialTitle = `E2E Edit Before ${Date.now()}`;
    const url = 'https://example.com/e2e-edit';

    await page.getByRole('button', { name: /create bookmark/i }).first().click();
    const createModal = page.getByRole('dialog');
    await expect(createModal).toBeVisible();
    await createModal.getByPlaceholder(/^https/i).fill(url);
    await createModal.getByPlaceholder(/^Title$/i).fill(initialTitle);
    const createPost = page.waitForResponse((res) => {
      if (res.request().method() !== 'POST' || res.status() >= 400) return false;
      try {
        return new URL(res.url()).pathname === '/api/bookmarks';
      } catch {
        return false;
      }
    });
    await createModal.getByRole('button', { name: /save/i }).click();
    await createPost;
    await expect(createModal).not.toBeVisible({ timeout: 10000 });
    await page.reload();
    await expect(page.getByRole('row').filter({ hasText: initialTitle }).first()).toBeVisible({
      timeout: 15000,
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

  test('deletes a bookmark from the table row menu after confirm', async ({ page }) => {
    await page.goto('/bookmarks?view=table');

    await expect(page.getByRole('heading', { level: 1, name: /^Bookmarks/ })).toBeVisible({ timeout: 10000 });

    const title = `E2E Delete ${Date.now()}`;
    const url = 'https://example.com/e2e-delete';

    await page.getByRole('button', { name: /create bookmark/i }).first().click();
    const createModal = page.getByRole('dialog');
    await expect(createModal).toBeVisible();
    await createModal.getByPlaceholder(/^https/i).fill(url);
    await createModal.getByPlaceholder(/^Title$/i).fill(title);
    const createPost = page.waitForResponse((res) => {
      if (res.request().method() !== 'POST' || res.status() >= 400) return false;
      try {
        return new URL(res.url()).pathname === '/api/bookmarks';
      } catch {
        return false;
      }
    });
    await createModal.getByRole('button', { name: /save/i }).click();
    await createPost;
    await expect(createModal).not.toBeVisible({ timeout: 10000 });
    await page.reload();
    await expect(page.getByRole('row').filter({ hasText: title }).first()).toBeVisible({ timeout: 15000 });

    const row = page.getByRole('row').filter({ hasText: title }).first();
    await row.getByRole('button', { name: /more actions/i }).click({ force: true });
    await page.getByRole('menuitem', { name: /^Delete$/i }).click();

    const confirm = page.getByRole('dialog', { name: /delete bookmark/i });
    await expect(confirm).toBeVisible({ timeout: 5000 });
    await confirm.getByRole('button', { name: /^Delete$/i }).click();

    await expect(confirm).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('row').filter({ hasText: title })).toHaveCount(0);
  });

  test('search query filters bookmarks by title', async ({ page }) => {
    const unique = `E2ESearch${Date.now()}`;
    const title = `${unique} marker`;
    const url = 'https://example.com/e2e-search';

    await page.goto('/bookmarks?view=table');

    await expect(page.getByRole('heading', { level: 1, name: /^Bookmarks/ })).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: /create bookmark/i }).first().click();
    const createModal = page.getByRole('dialog');
    await expect(createModal).toBeVisible();
    await createModal.getByPlaceholder(/^https/i).fill(url);
    await createModal.getByPlaceholder(/^Title$/i).fill(title);
    await createModal.getByRole('button', { name: /save/i }).click();
    await expect(createModal).not.toBeVisible({ timeout: 5000 });

    await page.goto(`/bookmarks?view=table&q=${encodeURIComponent(unique)}`);

    await expect(page.getByRole('heading', { level: 1, name: /^Bookmarks/ })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('row').filter({ hasText: title }).first()).toBeVisible({ timeout: 5000 });
  });
});
