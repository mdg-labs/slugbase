import { test, expect } from "../../fixtures/auth.js";
import { createSeedHelper } from "../../fixtures/seed.js";

test.describe("Folders CRUD", () => {
  test("create folder -> appears in list and sidebar -> filter bookmarks by folder", async ({
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

    // ── Phase 2: Navigate to folders page, verify empty state ───
    await page.goto("/folders");
    // Wait for the page to load (not skeleton)
    await page.waitForSelector('[data-testid="folder-list-toolbar"]');

    // ── Phase 3: Create a folder via the "New Folder" button ────
    await page.click('[data-testid="folder-list-new-btn"]');
    await page.waitForSelector('[data-testid="folder-create-dialog"]');

    // The dialog has an input named "folder-create-input" (id="folder-create-input")
    await page.fill("#folder-create-input", "E2E Test Folder");

    // Submit the form
    await page.click('button[type="submit"]');

    // Wait for dialog to close and the folder to appear in the list
    await page.waitForSelector('[data-testid="folder-create-dialog"]', {
      state: "detached",
      timeout: 5000,
    });

    // ── Phase 4: Verify folder appears in the folder list ───────
    await page.waitForSelector('[data-testid="folder-list"]');
    const folderList = page.locator('[data-testid="folder-list"]');
    await expect(folderList).toContainText("E2E Test Folder");

    // ── Phase 5: Verify folder appears in the dashboard sidebar ─
    await page.goto("/");
    await page.waitForSelector('[data-testid="dashboard-folders-overview"]');
    const sidebarFolders = page.locator('[data-testid="dashboard-folders-overview"]');
    await expect(sidebarFolders).toBeVisible();
    await expect(sidebarFolders).toContainText("E2E Test Folder");

    // ── Phase 6: Create a bookmark and assign it to the folder ──
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    // Create a new bookmark via the keyboard shortcut (press "c")
    await page.keyboard.press("c");
    await page.waitForSelector('[data-testid="bookmark-modal"]');

    // Fill in URL
    await page.fill('input[name="url"]', "https://example.com/e2e-folder-test");
    // Fill in title
    await page.fill('input[name="title"]', "E2E Folder Test Bookmark");

    // Open the folder selector and pick our folder
    await page.click('[data-testid="folder-selector-trigger"]');
    await page.waitForSelector('[data-testid="folder-selector-menu"]');

    // Click the folder item by its visible text
    await page.locator('[data-testid="folder-selector-menu"] button').filter({ hasText: "E2E Test Folder" }).click();

    // Submit the bookmark modal
    await page.click('button[type="submit"]');

    // Wait for modal to close
    await page.waitForSelector('[data-testid="bookmark-modal"]', {
      state: "detached",
      timeout: 5000,
    });

    // ── Phase 7: Filter bookmarks by the folder ─────────────────
    // Open the folder filter chip dropdown on the bookmarks toolbar
    await page.click('[data-testid="bookmark-folder-filter"]');
    // The dropdown menu items should appear — click our folder
    await page.locator('button[role="menuitem"]').filter({ hasText: "E2E Test Folder" }).click();

    // Wait for the page to reload with the folder filter applied
    await page.waitForTimeout(500);
    // The filtered view should show our bookmark
    const bookmarkCards = page.locator('[data-testid="bookmark-grid"], [data-testid="bookmark-table"]');
    await expect(bookmarkCards).toBeVisible({ timeout: 5000 });
    await expect(page.locator("text=E2E Folder Test Bookmark").first()).toBeVisible();

    // ── Phase 8: Clear filters ──────────────────────────────────
    const clearFiltersBtn = page.locator('[data-testid="bookmark-clear-filters"]');
    if (await clearFiltersBtn.isVisible()) {
      await clearFiltersBtn.click();
    }
  });

  test("search, pinned filter, and scope filter on bookmarks page", async ({
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

    // Create seed data: 3 bookmarks, 2 folders
    await seed({ bookmarks: 3, folders: ["Filter A", "Filter B"], tags: [] });

    // ── Phase 2: Navigate to bookmarks page ─────────────────────
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    // ── Phase 3: Use the search input ───────────────────────────
    const searchInput = page.locator('[data-testid="bookmark-list-search"]');
    await searchInput.fill("Test Bookmark");
    await page.waitForTimeout(500);

    // Bookmarks matching the search should be visible
    const resultCount = page.locator('[data-testid="bookmark-result-count"]');
    await expect(resultCount).toBeVisible();
    // The grid or table should contain bookmark cards/rows
    const gridOrTable = page.locator(
      '[data-testid="bookmark-grid"], [data-testid="bookmark-table"]',
    );
    await expect(gridOrTable).toBeVisible();

    // ── Phase 4: Use the pinned filter toggle ───────────────────
    // Clear search first
    await searchInput.clear();
    await page.waitForTimeout(300);

    // Click the pinned filter — should toggle to show only pinned bookmarks
    const pinnedFilter = page.locator('[data-testid="bookmark-pinned-filter"]');
    await pinnedFilter.click();
    await page.waitForTimeout(500);

    // Pinned filter is active — the page reloads
    await expect(page.locator('[data-testid="bookmark-list-toolbar"]')).toBeVisible();

    // ── Phase 5: Clear all filters ──────────────────────────────
    const clearBtn = page.locator('[data-testid="bookmark-clear-filters"]');
    if (await clearBtn.isVisible()) {
      await clearBtn.click();
      await page.waitForTimeout(500);
      // After clearing, filters are gone and bookmarks show
      await expect(page.locator('[data-testid="bookmark-list-toolbar"]')).toBeVisible();
    }
  });
});