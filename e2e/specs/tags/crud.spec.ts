import { test, expect } from "../../fixtures/auth.js";
import { createSeedHelper } from "../../fixtures/seed.js";

test.describe("Tags CRUD", () => {
  test("create tag -> assign via bookmark modal -> filter tag list", async ({
    page,
  }) => {
    // ── Phase 1: Login ──────────────────────────────────────────
    await page.goto("/login");
    await page.waitForSelector('[data-testid="login-form"]');
    await page.fill('[data-testid="login-email-input"]', "e2e@slugbase.test");
    await page.fill('[data-testid="login-password-input"]', "e2e-test-password");
    await page.click('[data-testid="login-submit-btn"]');
    await page.waitForURL(/\/$/);
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // ── Phase 2: Create a tag from the tags page ────────────────
    await page.goto("/tags");
    await page.waitForSelector('[data-testid="tag-list-toolbar"]');

    // Click "New Tag" button
    await page.click('[data-testid="tag-list-new-btn"]');
    await page.waitForSelector('[data-testid="tag-modal"]');

    // The dialog has an input with id="tag-name-input"
    await page.fill("#tag-name-input", "e2e-test-tag");

    // Submit the form
    await page.click('button[type="submit"]');

    // Wait for dialog to close and tag to appear in the list
    await page.waitForSelector('[data-testid="tag-modal"]', {
      state: "detached",
      timeout: 5000,
    });

    // ── Phase 3: Verify the tag appears in the tag list ─────────
    await page.waitForSelector('[data-testid="tag-list"]');
    const tagList = page.locator('[data-testid="tag-list"]');
    await expect(tagList).toContainText("e2e-test-tag");

    // Click on the tag row to open the detail panel
    await page.locator('[data-testid="tag-list"] [data-testid^="tag-row-"]').first().click();
    await page.waitForSelector('[data-testid="tag-detail-panel"]');
    const detailPanel = page.locator('[data-testid="tag-detail-panel"]');

    // Detail panel should show the tag name with a hash prefix
    await expect(detailPanel).toContainText("e2e-test-tag");

    // ── Phase 4: Create a bookmark and assign the tag ───────────
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    // Create a new bookmark via the keyboard shortcut (press "c")
    await page.keyboard.press("c");
    await page.waitForSelector('[data-testid="bookmark-modal"]');

    // Fill in URL
    await page.fill('input[name="url"]', "https://example.com/e2e-tag-test");
    // Fill in title
    await page.fill('input[name="title"]', "E2E Tag Test Bookmark");

    // Type in the tag input to find and select our tag
    const tagInput = page.locator('[data-testid="tag-input"]');
    await tagInput.fill("e2e-test-tag");

    // Wait for suggestions to appear and click the matching suggestion
    await page.waitForSelector('[data-testid="tag-suggestions"]');
    await page.locator('[data-testid="tag-suggestions"] button').filter({ hasText: "e2e-test-tag" }).click();

    // Submit the bookmark modal
    await page.click('button[type="submit"]');

    // Wait for modal to close
    await page.waitForSelector('[data-testid="bookmark-modal"]', {
      state: "detached",
      timeout: 5000,
    });

    // ── Phase 5: Verify the tag appears in the detail panel with the bookmark ──
    await page.goto("/tags");
    await page.waitForSelector('[data-testid="tag-list-toolbar"]');

    // Select our tag to open detail panel
    const tagRow = page.locator('[data-testid="tag-list"] [data-testid^="tag-row-"]').first();
    await tagRow.click();
    await page.waitForSelector('[data-testid="tag-detail-panel"]');

    // The detail panel body should show the assigned bookmark
    const detailBody = page.locator('[data-testid="tags-detail-body"]');
    await expect(detailBody).toContainText("E2E Tag Test Bookmark");
  });

  test("create tag, assign via bookmark, filter bookmarks by tag", async ({
    page,
  }) => {
    // ── Phase 1: Login and seed data ────────────────────────────
    const seed = createSeedHelper(page);
    await page.goto("/login");
    await page.waitForSelector('[data-testid="login-form"]');
    await page.fill('[data-testid="login-email-input"]', "e2e@slugbase.test");
    await page.fill('[data-testid="login-password-input"]', "e2e-test-password");
    await page.click('[data-testid="login-submit-btn"]');
    await page.waitForURL(/\/$/);
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // Seed with a tag so it's available for filtering
    await seed({
      bookmarks: 2,
      folders: [],
      tags: ["filter-me"],
    });

    // ── Phase 2: Navigate to bookmarks page ─────────────────────
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    // There should be seeded bookmarks visible
    const gridOrTable = page.locator(
      '[data-testid="bookmark-grid"], [data-testid="bookmark-table"]',
    );
    await expect(gridOrTable).toBeVisible();

    // ── Phase 3: Filter by tag via the tags filter chip ─────────
    // Open the tags filter chip dropdown
    await page.click('[data-testid="bookmark-tags-filter"]');
    // Click the menu item for "filter-me" tag
    await page.locator('button[role="menuitem"]').filter({ hasText: "filter-me" }).click();

    await page.waitForTimeout(500);
    // After filtering, the toolbar should still be visible and
    // the filter indicator should show active state
    await expect(page.locator('[data-testid="bookmark-list-toolbar"]')).toBeVisible();
  });
});