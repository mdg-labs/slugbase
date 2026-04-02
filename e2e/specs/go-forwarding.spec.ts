/**
 * Go forwarding: create a bookmark with a slug, then /go/:slug redirects to the bookmark URL.
 * Uses a target URL on the same origin so we can assert the final location.
 */
import { test, expect } from '@playwright/test';

test.describe('Go forwarding', () => {
  test('redirects /go/:slug to bookmark URL', async ({ page, baseURL }) => {
    const slug = `e2e-go-${Date.now()}`;
    const targetPath = '/bookmarks';
    const targetUrl = `${baseURL?.replace(/\/$/, '') || 'http://localhost:3000'}${targetPath}`;

    await page.goto('/bookmarks');

    await expect(
      page.getByRole('heading', { level: 1, name: /^Bookmarks/ })
    ).toBeVisible({ timeout: 10000 });

    const createButton = page.getByRole('main').getByRole('button', {
      name: /create bookmark/i,
    });
    await createButton.click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    await modal.getByPlaceholder(/title/i).fill(`Go test ${slug}`);
    await modal.getByPlaceholder(/^url$/i).fill(targetUrl);
    await modal.getByRole('switch', { name: /enable forwarding/i }).click();
    await modal.getByPlaceholder(/slug/i).fill(slug);
    await modal.locator('#bookmark-form').evaluate((el) => (el as HTMLFormElement).requestSubmit());

    await expect(modal).not.toBeVisible({ timeout: 5000 });

    await page.goto(`/go/${slug}`);

    await expect(page).toHaveURL(/\/bookmarks/, { timeout: 15000 });
  });
});
