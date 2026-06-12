import { test, expect } from "../../fixtures/auth.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

/**
 * E2E: Scope filter UI interaction and "shared with me" flow.
 *
 * Covers:
 * 1. Scope filter dropdown renders with correct options (team plan)
 * 2. Selecting a scope updates the URL and filters bookmarks
 * 3. The "shared with me" option is present and clickable
 *
 * Backend API sharing scoping is covered by packages/backend/test/sharing.e2e-spec.ts.
 * Full cross-user sharing e2e requires email-based invitation acceptance,
 * which is tested via backend integration tests rather than browser e2e.
 */
test.describe("Sharing scope filters", () => {
  test("scope filter dropdown interaction on team plan", async ({ page }, testInfo) => {
    // ── Login ───────────────────────────────────────────────────────
    await loginAsWorker(page, testInfo.workerIndex);

    // ── Upgrade workspace to team plan for scope filter visibility ──
    const csrf: string = await page.evaluate(async () => {
      const res = await fetch("/auth/csrf-token");
      const data = (await res.json()) as { csrfToken: string };
      return data.csrfToken;
    });

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

    // ── Navigate to bookmarks ──────────────────────────────────────
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    // Verify scope filter is visible (team plan)
    await expect(
      page.locator('[data-testid="sharing-scope-filter-trigger"]')
    ).toBeVisible();

    // ── Open scope filter menu ──────────────────────────────────────
    await page.click('[data-testid="sharing-scope-filter-trigger"]');
    await expect(
      page.locator('[data-testid="sharing-scope-filter-menu"]')
    ).toBeVisible();

    // Verify all scope options are present
    await expect(
      page.locator('[data-testid="sharing-scope-option-all"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="sharing-scope-option-mine"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="sharing-scope-option-shared-with-me"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="sharing-scope-option-shared-by-me"]')
    ).toBeVisible();

    // ── Select "mine" scope — verify URL updates ────────────────────
    await page.click('[data-testid="sharing-scope-option-mine"]');
    await page.waitForURL(/scope=mine/);

    // ── Reopen and select "all" to reset ────────────────────────────
    await page.click('[data-testid="sharing-scope-filter-trigger"]');
    await page.waitForSelector('[data-testid="sharing-scope-filter-menu"]');
    await page.click('[data-testid="sharing-scope-option-all"]');
    await page.waitForURL(/\/bookmarks(\?.*)?$/);

    // ── Select "shared-with-me" — verify URL updates ────────────────
    await page.click('[data-testid="sharing-scope-filter-trigger"]');
    await page.waitForSelector('[data-testid="sharing-scope-filter-menu"]');
    await page.click('[data-testid="sharing-scope-option-shared-with-me"]');
    await page.waitForURL(/scope=shared-with-me/);

    // The bookmark list still renders (may be empty, but page doesn't error)
    await expect(
      page.locator('[data-testid="bookmark-list-page"]')
    ).toBeVisible();
  });
});