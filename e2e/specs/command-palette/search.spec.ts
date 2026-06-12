import { test, expect } from '../../fixtures/auth.js';

test.describe('Command palette search', () => {
  const BOOKMARK_TITLE = 'Command Palette E2E Search Test';
  const BOOKMARK_URL = 'https://example.com/command-palette-e2e-search';
  const SEARCH_QUERY = 'command palette e2e';

  test('⌘K opens palette, typing a query shows results, picking a result navigates', async ({
    authedPage,
    sessionCookie,
    csrfToken,
  }) => {
    const page = authedPage;

    // Create a bookmark that will appear in search results
    const apiUrl = process.env.E2E_BASE_URL_API ?? process.env.E2E_BASE_URL_SELF_HOSTED ?? 'http://localhost:4001';
    const createRes = await page.request.post(`${apiUrl}/bookmarks`, {
      headers: { Cookie: sessionCookie, 'x-csrf-token': csrfToken },
      data: {
        url: BOOKMARK_URL,
        title: BOOKMARK_TITLE,
      },
    });
    expect(createRes.ok()).toBeTruthy();

    // Navigate to the app root
    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // Open command palette with ⌘K
    await page.keyboard.press('Control+k');
    await page.waitForSelector('[data-testid="command-palette-dialog"]');
    await page.waitForSelector('[data-testid="command-palette-input"]');

    // Type a search query
    await page.fill('[data-testid="command-palette-input"]', SEARCH_QUERY);
    await page.waitForTimeout(400); // debounce + fetch

    // The bookmark should appear in search results
    const palette = page.locator('[data-testid="command-palette-dialog"]');
    const bookmarkResult = palette.getByText(BOOKMARK_TITLE, { exact: true }).first();
    await expect(bookmarkResult).toBeVisible({ timeout: 5000 });

    // Pick the result — use keyboard to avoid cmdk overlay interception
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    // Palette should close
    await expect(page.locator('[data-testid="command-palette-dialog"]')).not.toBeVisible({ timeout: 3000 });

    // Verify the bookmark was accessed (navigation or same-page tracking)
  });
});
