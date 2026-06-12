import { test, expect } from "../../fixtures/auth.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

test.describe("Bookmark bulk actions", () => {
  test("select multiple bookmarks, bulk pin, move to folder, and delete", async ({
    page,
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    // ── Phase 1: Login ──────────────────────────────────────────────
    await loginAsWorker(page, testInfo.workerIndex);

    // ── Phase 2: Seed bookmarks and folder via API ─────────────────
    const apiUrl = process.env.E2E_BASE_URL_API ?? process.env.E2E_BASE_URL_SELF_HOSTED ?? 'http://localhost:4001';
    const apiHeaders = { Cookie: sessionCookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" };

    const bookmarkIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await page.request.post(`${apiUrl}/bookmarks`, {
        headers: apiHeaders,
        data: { url: `https://example.com/bulk-e2e-${i}`, title: `Bulk E2E Bookmark ${i}` },
      });
      expect(res.ok(), `Bookmark creation ${i} failed: ${res.status()}`).toBeTruthy();
      const created = await res.json() as { id: string };
      bookmarkIds.push(created.id);
    }

    const folderRes = await page.request.post(`${apiUrl}/folders`, {
      headers: apiHeaders,
      data: { name: "Bulk Test Folder" },
    });
    expect(folderRes.ok(), `Folder creation failed: ${folderRes.status()}`).toBeTruthy();
    const { id: folderId } = await folderRes.json() as { id: string };

    expect(bookmarkIds).toHaveLength(3);
    expect(folderId).toBeTruthy();

    // ── Phase 3: Navigate to bookmarks and filter to our test data ──
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');
    await page.waitForSelector('[data-testid="bookmark-result-count"]');

    // Search to isolate only the 3 bookmarks we just created
    const searchInput = page.locator('[data-testid="bookmark-list-search"]');
    await searchInput.fill("Bulk E2E Bookmark");
    await page.waitForTimeout(500);
    await page.waitForSelector('[data-testid="bookmark-result-count"]');
    await expect(page.locator('[data-testid="bookmark-result-count"]')).toContainText("3");

    // ── Phase 4: Toggle bulk select mode ────────────────────────────
    await page.click('[data-testid="bookmark-bulk-select-toggle"]');

    // Verify bulk bar is not yet visible (no items selected)
    await expect(page.locator('[data-testid="bulk-bar"]')).not.toBeVisible();

    // Select all 3 bookmarks by clicking on cards
    const cards = page.locator('[data-testid^="bookmark-card-"]');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThanOrEqual(3);

    // Click each card to select it
    for (let i = 0; i < 3; i++) {
      await cards.nth(i).click();
    }

    // Bulk bar should now be visible
    await expect(page.locator('[data-testid="bulk-bar"]')).toBeVisible();
    await expect(page.locator('[data-testid="bulk-bar"]')).toContainText("3");

    // ── Phase 5: Bulk pin ──────────────────────────────────────────
    await page.locator('[data-testid="bulk-bar"] button').filter({ hasText: "Pin" }).click();

    // Wait for navigation/re-render after pin
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="bookmark-result-count"]')).toContainText("3");

    // ── Phase 6: Bulk move to folder ───────────────────────────────
    // Re-enter bulk select mode and reselect (selection cleared by pin action)
    await page.click('[data-testid="bookmark-bulk-select-toggle"]');
    await page.click('[data-testid="bookmark-bulk-select-toggle"]');

    const cards2 = page.locator('[data-testid^="bookmark-card-"]');
    const cardCount2 = await cards2.count();
    expect(cardCount2).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 3; i++) {
      await cards2.nth(i).click();
    }
    await expect(page.locator('[data-testid="bulk-bar"]')).toBeVisible();

    // Open the "Move to folder" dropdown
    const moveTrigger = page.locator('[data-testid="bulk-move-trigger"]');
    await moveTrigger.click();

    // Click the folder option
    await page.getByRole("menuitem", { name: "Bulk Test Folder" }).click();

    // Wait for navigation/re-render
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="bookmark-result-count"]')).toContainText("3");

    // ── Phase 7: Bulk delete ───────────────────────────────────────
    // Re-enter bulk select mode and reselect
    await page.click('[data-testid="bookmark-bulk-select-toggle"]');
    await page.click('[data-testid="bookmark-bulk-select-toggle"]');

    const cards3 = page.locator('[data-testid^="bookmark-card-"]');
    const cardCount3 = await cards3.count();
    expect(cardCount3).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 3; i++) {
      await cards3.nth(i).click();
    }
    await expect(page.locator('[data-testid="bulk-bar"]')).toBeVisible();

    // Click "Delete" in the bulk bar
    await page.locator('[data-testid="bulk-bar"] button').filter({ hasText: "Delete" }).click();

    // Wait for the page to re-render — our search filter should now show 0 matching results
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="bookmark-result-count"]')).toContainText("0");
  });
});
