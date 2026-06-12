import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/auth.js';
import { isHostedE2eProject } from '../../helpers/deployment-project.js';
import { e2eResourceSuffix } from '../../helpers/e2e-resource-id.js';

const apiUrl = () =>
  process.env.E2E_BASE_URL_API
  ?? process.env.E2E_BASE_URL_SELF_HOSTED
  ?? 'http://localhost:4001';

/** On hosted, team plan avoids free bookmark-cap collisions from parallel entitlements tests. */
async function ensureTeamPlanForBookmarkCreate(
  page: Page,
  sessionCookie: string,
  csrfToken: string,
): Promise<void> {
  const res = await page.request.patch(`${apiUrl()}/workspaces/active`, {
    headers: {
      Cookie: sessionCookie,
      'x-csrf-token': csrfToken,
      'Content-Type': 'application/json',
    },
    data: { plan: 'team' },
  });
  expect(res.ok(), `Plan upgrade failed: ${res.status()}`).toBeTruthy();
}

test.describe('Command palette go mode', () => {
  test('⌘K → go <slug> resolves or opens disambiguation', async ({
    authedPage,
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    const page = authedPage;
    const SLUG = `e2e-gotest-${e2eResourceSuffix(testInfo)}`;
    const BOOKMARK_TITLE = 'Go Mode E2E Test';
    const BOOKMARK_URL = 'https://example.com/e2e-go-test';

    if (isHostedE2eProject(testInfo)) {
      await ensureTeamPlanForBookmarkCreate(page, sessionCookie, csrfToken);
    }

    // Create a bookmark with slug + forwarding enabled so it appears in go mode
    const createRes = await page.request.post(`${apiUrl()}/bookmarks`, {
      headers: { Cookie: sessionCookie, 'x-csrf-token': csrfToken },
      data: {
        url: BOOKMARK_URL,
        title: BOOKMARK_TITLE,
        slug: SLUG,
        forwardingEnabled: true,
      },
    });
    expect(
      createRes.ok(),
      `Bookmark creation failed: ${createRes.status()} ${await createRes.text()}`,
    ).toBeTruthy();

    // Navigate to the app root
    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // Open command palette with ⌘K
    await page.keyboard.press('Control+k');
    await page.waitForSelector('[data-testid="command-palette-dialog"]');
    await page.waitForSelector('[data-testid="command-palette-input"]');

    // Type "go " prefix to enter go mode, then the slug
    // cmdk auto-focuses the input; use keyboard to trigger onValueChange
    await page.keyboard.type(`go ${SLUG.slice(0, 4)}`, { delay: 30 });
    await page.waitForTimeout(400); // debounce + fetch

    // The go mode item for our slug should appear
    const goItem = page.locator(`[data-testid="go-mode-item-${SLUG}"]`);
    await expect(goItem).toBeVisible({ timeout: 5000 });

    // Select the go mode item — use keyboard to bypass cmdk-overlay intercepting clicks
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    // Palette should close
    await expect(page.locator('[data-testid="command-palette-dialog"]')).not.toBeVisible({ timeout: 3000 });

    // The page should have navigated — with forwarding enabled, it redirects to the external URL
    await expect(page).toHaveURL(/example\.com/, { timeout: 5000 });
  });

  test('go mode works with full slug and Enter key', async ({
    authedPage,
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    const page = authedPage;

    // Create a bookmark with a distinct slug
    const fullSlug = `e2e-enter-${e2eResourceSuffix(testInfo)}`;

    if (isHostedE2eProject(testInfo)) {
      await ensureTeamPlanForBookmarkCreate(page, sessionCookie, csrfToken);
    }

    const createRes = await page.request.post(`${apiUrl()}/bookmarks`, {
      headers: { Cookie: sessionCookie, 'x-csrf-token': csrfToken },
      data: {
        url: `https://example.com/${fullSlug}`,
        title: 'Go Mode Enter Test',
        slug: fullSlug,
        forwardingEnabled: true,
      },
    });
    expect(
      createRes.ok() || createRes.status() === 409,
      `Bookmark creation failed: ${createRes.status()} ${await createRes.text()}`,
    ).toBeTruthy();

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

    // The slug resolves via forwarding — the browser navigates to the external URL
    await expect(page).toHaveURL(/example\.com/, { timeout: 5000 });
  });
});
