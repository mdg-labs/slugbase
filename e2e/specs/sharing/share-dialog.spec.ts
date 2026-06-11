import { test, expect } from "../../fixtures/auth.js";

/**
 * E2E: Share dialog visibility and entitlement gating.
 *
 * Prerequisites: Requires seeded e2e@slugbase.test account with workspace.
 * Backend API sharing covered by packages/backend/test/sharing.e2e-spec.ts.
 *
 * Tests:
 * 1. Entitlement gate: free plan hides ShareControls, scope filter
 * 2. Team plan enables ShareDialog and scope filter
 * 3. ShareDialog renders expected structure
 */
test.describe("Share dialog", () => {
  test("free plan hides share controls, team plan shows share dialog", async ({
    page,
  }) => {
    // ── Phase 1: Login ──────────────────────────────────────────────
    await page.goto("/login");
    await page.waitForSelector('[data-testid="login-form"]');
    await page.fill('[data-testid="login-email-input"]', "e2e@slugbase.test");
    await page.fill('[data-testid="login-password-input"]', "e2e-test-password");
    await page.click('[data-testid="login-submit-btn"]');
    await page.waitForURL(/\/$/);
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // ── Phase 2: Create a bookmark via the page's action ────────────
    const csrf = await page.evaluate(async () => {
      const res = await fetch("/auth/csrf-token");
      const data = (await res.json()) as { csrfToken: string };
      return data.csrfToken;
    });

    const bookmarkId = await page.evaluate(async (token) => {
      const res = await fetch("/bookmarks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": token,
        },
        body: JSON.stringify({
          url: "https://example.com/share-e2e",
          title: "Share E2E Bookmark",
        }),
      });
      if (!res.ok) throw new Error(`Create bookmark failed: ${res.status}`);
      const data = (await res.json()) as { id: string };
      return data.id;
    }, csrf);

    // ── Phase 3: Entitlement gate — free plan hides scope filter ────
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    // Free workspace: scope filter should be absent
    await expect(
      page.locator('[data-testid="sharing-scope-filter-trigger"]')
    ).not.toBeVisible();

    // ── Phase 4: Free plan bookmark modal shows upgrade gate text ───
    const moreBtn = page.locator('button[aria-label="More options"]').first();
    await moreBtn.click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await page.waitForSelector('[data-testid="bookmark-modal"]');

    // ShareControls button should not be visible (free plan — canShare=false)
    const shareBtn = page.locator(
      `[data-testid="share-controls-bookmark-${bookmarkId}"]`
    );
    await expect(shareBtn).not.toBeVisible();

    // Close modal
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="bookmark-modal"]', {
      state: "hidden",
    });

    // ── Phase 5: Upgrade workspace to team plan ─────────────────────
    await page.evaluate(async (token) => {
      const res = await fetch("/workspaces/active", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": token,
        },
        body: JSON.stringify({ plan: "team" }),
      });
      if (!res.ok) throw new Error(`Upgrade failed: ${res.status}`);
    }, csrf);

    // ── Phase 6: Team plan shows scope filter ───────────────────────
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');
    await expect(
      page.locator('[data-testid="sharing-scope-filter-trigger"]')
    ).toBeVisible();

    // ── Phase 7: Team plan bookmark modal shows ShareControls ───────
    const moreBtn2 = page
      .locator('button[aria-label="More options"]')
      .first();
    await moreBtn2.click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await page.waitForSelector('[data-testid="bookmark-modal"]');

    await expect(
      page.locator(`[data-testid="share-controls-bookmark-${bookmarkId}"]`)
    ).toBeVisible();

    // ── Phase 8: Open ShareDialog ───────────────────────────────────
    await page.click(
      `[data-testid="share-controls-bookmark-${bookmarkId}"]`
    );
    await page.waitForSelector('[data-testid="share-dialog"]');

    // Verify dialog structure
    await expect(
      page.locator('[data-testid="share-dialog-target-kind"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="share-dialog-target-select"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="share-dialog-grant-button"]')
    ).toBeVisible();
    // Should show empty state since no grants exist yet
    await expect(
      page.locator('[data-testid="share-dialog-empty"]')
    ).toBeVisible();

    // Close dialog
    await page.click(
      '[data-testid="share-dialog"] button:has-text("Close")'
    );
    await page.waitForSelector('[data-testid="share-dialog"]', {
      state: "hidden",
    });
  });
});