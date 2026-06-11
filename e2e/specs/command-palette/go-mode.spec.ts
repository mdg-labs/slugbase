import { test, expect } from '../../fixtures/auth.js';

test.describe('Command palette go mode', () => {
  const SLUG = 'e2e-gotest';
  const BOOKMARK_TITLE = 'Go Mode E2E Test';
  const BOOKMARK_URL = 'https://example.com/e2e-go-test';

  test('⌘K → go <slug> resolves or opens disambiguation', async ({ authedPage }) => {
    const page = authedPage;

    // Create a bookmark with slug + forwarding enabled so it appears in go mode
    const apiUrl = page.context().request.defaultHeaders()?.['X-E2E-Base-URL-API'] ?? 'http://localhost:4001';
    const createRes = await page.request.post(`${apiUrl}/api/v1/bookmarks`, {
      data: {
        url: BOOKMARK_URL,
        title: BOOKMARK_TITLE,
        slug: SLUG,
        forwardingEnabled: true,
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

    // Type "go " prefix to enter go mode
    await page.fill('[data-testid="command-palette-input"]', 'go ');
    // The go mode badge should appear
    await page.waitForSelector('[data-testid="go-mode-badge"]', { timeout: 5000 });

    // Continue typing the slug prefix
    await page.fill('[data-testid="command-palette-input"]', `go ${SLUG.slice(0, 4)}`);
    await page.waitForTimeout(400); // debounce + fetch

    // The go mode item for our slug should appear
    const goItem = page.locator(`[data-testid="go-mode-item-${SLUG}"]`);
    await expect(goItem).toBeVisible({ timeout: 5000 });

    // Select the go mode item — this navigates via window.location.assign to /go/:slug
    await goItem.click();

    // Palette should close
    await expect(page.locator('[data-testid="command-palette-dialog"]')).not.toBeVisible({ timeout: 3000 });

    // The page should have navigated toward the go route
    // window.location.assign navigates in the same page context
    await expect(page).toHaveURL(/\/go\//, { timeout: 5000 });
  });

  test('go mode works with full slug and Enter key', async ({ authedPage }) => {
    const page = authedPage;

    // Create a bookmark with a distinct slug
    const apiUrl = page.context().request.defaultHeaders()?.['X-E2E-Base-URL-API'] ?? 'http://localhost:4001';
    const fullSlug = 'e2e-enter-test';
    const createRes = await page.request.post(`${apiUrl}/api/v1/bookmarks`, {
      data: {
        url: 'https://example.com/e2e-enter-test',
        title: 'Go Mode Enter Test',
        slug: fullSlug,
        forwardingEnabled: true,
      },
    });
    expect(createRes.ok()).toBeTruthy();

    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // Open palette
    await page.keyboard.press('Control+k');
    await page.waitForSelector('[data-testid="command-palette-dialog"]');
    await page.waitForSelector('[data-testid="command-palette-input"]');

    // Type full go command with exact slug
    await page.fill('[data-testid="command-palette-input"]', `go ${fullSlug}`);
    await page.waitForTimeout(400);

    // The go mode item should be visible
    const goItem = page.locator(`[data-testid="go-mode-item-${fullSlug}"]`);
    await expect(goItem).toBeVisible({ timeout: 5000 });

    // Press Enter to resolve via keyboard
    await page.keyboard.press('Enter');

    // Palette should close
    await expect(page.locator('[data-testid="command-palette-dialog"]')).not.toBeVisible({ timeout: 3000 });

    // Should have navigated to the go route
    await expect(page).toHaveURL(new RegExp(`/go/${fullSlug}`), { timeout: 5000 });
  });
});