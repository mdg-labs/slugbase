import { test, expect } from "../../fixtures/auth.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

/**
 * E2E: Share dialog visibility and entitlement gating.
 *
 * Prerequisites: Requires seeded test account with workspace.
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
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    // ── Phase 1: Login ──────────────────────────────────────────────
    await loginAsWorker(page, testInfo.workerIndex);

    const apiUrl = process.env.E2E_BASE_URL_API ?? process.env.E2E_BASE_URL_SELF_HOSTED ?? 'http://localhost:4001';
    const apiHeaders = { Cookie: sessionCookie, "x-csrf-token": csrfToken };

    // ── Phase 1.5: Reset workspace to free plan ─────────────────────
    // Parallel test workers may have upgraded the plan; reset it so we
    // can test the free-plan entitlement gate for share controls.
    const resetRes = await page.request.patch(`${apiUrl}/workspaces/active`, {
      headers: { ...apiHeaders, "Content-Type": "application/json" },
      data: { plan: "free" },
    });
    expect(resetRes.ok(), `Plan reset failed: ${resetRes.status()}`).toBeTruthy();

    // ── Phase 2: Create a bookmark via the API directly ──────────────
    const createRes = await page.request.post(`${apiUrl}/bookmarks`, {
      headers: apiHeaders,
      data: {
        url: "https://example.com/share-e2e",
        title: "Share E2E Bookmark",
      },
    });
    expect(createRes.ok(), `Bookmark creation failed: ${createRes.status()}`).toBeTruthy();
    const { id: bookmarkId } = await createRes.json() as { id: string };

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
    const upgradeRes = await page.request.patch(`${apiUrl}/workspaces/active`, {
      headers: { ...apiHeaders, "Content-Type": "application/json" },
      data: { plan: "team" },
    });
    expect(upgradeRes.ok(), `Upgrade failed: ${upgradeRes.status()}`).toBeTruthy();

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
