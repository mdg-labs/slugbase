import { test, expect } from "../../fixtures/auth.js";

test.describe("Bookmark bulk actions", () => {
  test("select multiple bookmarks, bulk pin, move to folder, and delete", async ({
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

    // ── Phase 2: Seed bookmarks and folder via API ─────────────────
    // Uses page.evaluate so the browser session cookie is sent automatically.
    // CSRF token is fetched first, then used for mutations.
    const seededIds = await page.evaluate(async () => {
      // Helper to get a CSRF token
      const getCsrfToken = async (): Promise<string> => {
        const res = await fetch("/auth/csrf-token");
        const data = (await res.json()) as { csrfToken: string };
        return data.csrfToken;
      };

      // Helper to POST JSON with CSRF
      const apiPost = async (
        path: string,
        body: Record<string, unknown>,
        csrf: string,
      ): Promise<Record<string, unknown>> => {
        const res = await fetch(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
        return (await res.json()) as Record<string, unknown>;
      };

      // Helper to PATCH JSON with CSRF
      const apiPatch = async (
        path: string,
        body: Record<string, unknown>,
        csrf: string,
      ): Promise<void> => {
        const res = await fetch(path, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
      };

      // Helper to DELETE with CSRF
      const apiDelete = async (path: string, csrf: string): Promise<void> => {
        const res = await fetch(path, {
          method: "DELETE",
          headers: { "x-csrf-token": csrf },
        });
        if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
      };

      const csrf = await getCsrfToken();

      // Create 3 bookmarks
      const bookmarkIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const created = (await apiPost(
          "/bookmarks",
          {
            url: `https://example.com/bulk-e2e-${i}`,
            title: `Bulk E2E Bookmark ${i}`,
          },
          csrf,
        )) as { id: string };
        bookmarkIds.push(created.id);
      }

      // Create a folder
      const folder = (await apiPost(
        "/folders",
        { name: "Bulk Test Folder" },
        csrf,
      )) as { id: string };

      return { bookmarkIds, folderId: folder.id };
    });

    expect(seededIds.bookmarkIds).toHaveLength(3);
    expect(seededIds.folderId).toBeTruthy();

    // ── Phase 3: Navigate to bookmarks and verify list ──────────────
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');
    await page.waitForSelector('[data-testid="bookmark-result-count"]');
    await expect(page.locator('[data-testid="bookmark-result-count"]')).toContainText("3");

    // ── Phase 4: Toggle bulk select mode ────────────────────────────
    await page.click('[data-testid="bookmark-bulk-select-toggle"]');

    // Verify bulk bar is not yet visible (no items selected)
    await expect(page.locator('[data-testid="bulk-bar"]')).not.toBeVisible();

    // Select all bookmarks by clicking on cards
    // In grid view, cards have role="article" and data-testid="bookmark-card-*"
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
    // Re-select all bookmarks (selection was cleared by pin action)
    // Toggle bulk select off then back on
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
    // Re-select all bookmarks
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

    // Wait for the page to re-render — should show 0 bookmarks (empty state)
    await page.waitForTimeout(500);
    await page.waitForSelector('[data-testid="bookmark-list-empty"]');
  });
});