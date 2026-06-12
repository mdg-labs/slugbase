import { test, expect } from "../../fixtures/auth.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

test.describe("Bookmark CRUD", () => {
  test("create, edit, and delete a bookmark via the UI", async ({ page }, testInfo) => {
    // ── Phase 1: Login ──────────────────────────────────────────────
    await loginAsWorker(page, testInfo.workerIndex);

    // ── Phase 2: Navigate to bookmarks ──────────────────────────────
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    // ── Phase 3: Create a bookmark via the modal ────────────────────
    await page.click('button[aria-label="New bookmark"]');
    await page.waitForSelector('[data-testid="bookmark-modal"]');
    await page.fill('input[name="url"]', "https://example.com/e2e-test-bookmark");
    await page.fill('input[name="title"]', "E2E Test Bookmark");
    await page.click('button[type="submit"]');

    // Wait for modal to close and page to refresh
    await page.waitForSelector('[data-testid="bookmark-modal"]', { state: "hidden" });
    await page.waitForSelector('[data-testid="bookmark-result-count"]');

    // Verify bookmark appears in the list
    await expect(page.locator('[data-testid="bookmark-result-count"]')).toContainText("1");
    await expect(page.getByText("E2E Test Bookmark")).toBeVisible();

    // ── Phase 4: Edit the bookmark ─────────────────────────────────
    // Open the context menu via "More options"
    const moreBtn = page.locator('button[aria-label="More options"]').first();
    await moreBtn.click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await page.waitForSelector('[data-testid="bookmark-modal"]');

    // Update the title
    await page.fill('input[name="title"]', "");
    await page.fill('input[name="title"]', "E2E Test Bookmark Edited");
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="bookmark-modal"]', { state: "hidden" });

    // Verify the edit is reflected
    await expect(page.getByText("E2E Test Bookmark Edited")).toBeVisible();

    // ── Phase 5: Delete the bookmark ───────────────────────────────
    const moreBtn2 = page.locator('button[aria-label="More options"]').first();
    await moreBtn2.click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.waitForSelector('[data-testid="bookmark-delete-dialog"]');
    await page.getByRole("button", { name: "Delete bookmark" }).click();
    await page.waitForSelector('[data-testid="bookmark-delete-dialog"]', { state: "hidden", timeout: 10000 });

    // Verify the bookmark is removed — empty state should show
    await expect(page.getByText("E2E Test Bookmark Edited")).not.toBeVisible();
  });
});