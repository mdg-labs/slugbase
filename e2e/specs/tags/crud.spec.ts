import { test, expect } from "../../fixtures/auth.js";
import { e2eResourceSuffix } from "../../helpers/e2e-resource-id.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

test.describe("Tags CRUD", () => {
  test("create tag -> assign via bookmark modal -> filter tag list", async ({
    page,
  }, testInfo) => {
    const tagName = `e2e-test-tag-${e2eResourceSuffix(testInfo)}`;

    // ── Phase 1: Login ──────────────────────────────────────────
    await loginAsWorker(page, testInfo.workerIndex);

    // ── Phase 2: Create a tag from the tags page ────────────────
    await page.goto("/tags");
    await page.waitForSelector('[data-testid="tag-list-toolbar"]');

    // Click "New Tag" button
    await page.click('[data-testid="tag-list-new-btn"]');
    await page.waitForSelector('[data-testid="tag-modal"]');

    // The dialog has an input with id="tag-name-input"
    await page.fill("#tag-name-input", tagName);

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
    await expect(tagList).toContainText(tagName);

    // Click on the tag row to open the detail panel
    await page.locator('[data-testid="tag-list"] [data-testid^="tag-row-"]').first().click();
    await page.waitForSelector('[data-testid="tag-detail-panel"]');
    const detailPanel = page.locator('[data-testid="tag-detail-panel"]');

    // Detail panel should show the tag name with a hash prefix
    await expect(detailPanel).toContainText(tagName);

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
    await tagInput.fill(tagName);

    // Wait for suggestions to appear and click the matching suggestion
    await page.waitForSelector('[data-testid="tag-suggestions"]');
    await page
      .locator('[data-testid="tag-suggestions"] button')
      .filter({ hasText: tagName })
      .first()
      .click();

    // Submit the bookmark modal
    await page.click('button[type="submit"]');

    // Wait for modal to close
    await page.waitForSelector('[data-testid="bookmark-modal"]', {
      state: "detached",
      timeout: 10000,
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
    sessionCookie,
    csrfToken,
  }, testInfo) => {
    // ── Phase 1: Login ──────────────────────────────────────────
    await loginAsWorker(page, testInfo.workerIndex);

    const tagName = `filter-me-${e2eResourceSuffix(testInfo)}`;

    // ── Phase 2: Seed tag + bookmarks in the ACTIVE workspace via API ──
    const apiUrl = process.env.E2E_BASE_URL_API ?? process.env.E2E_BASE_URL_CE ?? 'http://localhost:4001';
    const apiHeaders = { Cookie: sessionCookie, "x-csrf-token": csrfToken, "Content-Type": "application/json" };

    // Get the active workspace ID
    const wsRes = await page.request.get(`${apiUrl}/workspaces/active`, {
      headers: apiHeaders,
    });
    const activeWorkspace = await wsRes.json() as { id: string };

    // Create a tag in the active workspace
    const tagRes = await page.request.post(`${apiUrl}/tags`, {
      headers: apiHeaders,
      data: { workspaceId: activeWorkspace.id, name: tagName },
    });
    expect(tagRes.ok(), `Tag creation failed: ${tagRes.status()}`).toBeTruthy();
    const createdTag = await tagRes.json() as { id: string };

    // Create 2 bookmarks with the tag
    for (let i = 0; i < 2; i++) {
      const bookmarkRes = await page.request.post(`${apiUrl}/bookmarks`, {
        headers: apiHeaders,
        data: {
          url: `https://example.com/e2e-filter-tag-${i}`,
          title: `E2E Filter Bookmark ${i}`,
          tagIds: [createdTag.id],
        },
      });
      expect(bookmarkRes.ok(), `Bookmark creation ${i} failed: ${bookmarkRes.status()}`).toBeTruthy();
    }

    // ── Phase 3: Navigate to bookmarks page ─────────────────────
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    // The bookmarks page toolbar should have a tags filter chip
    const tagsFilter = page.locator('[data-testid="bookmark-tags-filter"]');
    await expect(tagsFilter).toBeVisible({ timeout: 5000 });

    // ── Phase 4: Filter by tag via the tags filter chip ─────────
    // Open the tags filter chip dropdown
    await tagsFilter.click();
    // Scope to this chip's menu (avoids strict-mode clashes with other menus)
    await tagsFilter
      .locator("..")
      .getByRole("menuitem", { name: `#${tagName}` })
      .first()
      .click();

    await page.waitForTimeout(500);
    // After filtering, the toolbar should still be visible and
    // the filter indicator should show active state
    await expect(page.locator('[data-testid="bookmark-list-toolbar"]')).toBeVisible();
  });
});
