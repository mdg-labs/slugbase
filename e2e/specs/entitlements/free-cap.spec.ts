import { test, expect } from "../../fixtures/auth.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

test.describe("Free bookmark cap", () => {
  test("free workspace at cap shows bookmark-cap-banner and upgrade CTA", async ({
    page,
  }, testInfo) => {
    // ── Phase 1: Login ──────────────────────────────────────────────
    await loginAsWorker(page, testInfo.workerIndex);

    // ── Phase 2: Reset workspace to free plan ───────────────────────
    // Parallel test workers may have upgraded the plan; reset it so the
    // bookmark cap (50) applies and the cap banner renders.
    await page.evaluate(async () => {
      const getCsrfToken = async (): Promise<string> => {
        const res = await fetch("/auth/csrf-token");
        const data = (await res.json()) as { csrfToken: string };
        return data.csrfToken;
      };

      const csrf = await getCsrfToken();
      const res = await fetch("/workspaces/active", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ plan: "free" }),
      });
      if (!res.ok) {
        throw new Error(`Failed to reset workspace plan: ${res.status}`);
      }
    });

    // ── Phase 3: Seed bookmarks to reach the free cap (50) via API ─
    await page.evaluate(async () => {
      const getCsrfToken = async (): Promise<string> => {
        const res = await fetch("/auth/csrf-token");
        const data = (await res.json()) as { csrfToken: string };
        return data.csrfToken;
      };

      const csrf = await getCsrfToken();

      // Create 50 bookmarks to hit the free cap
      for (let i = 0; i < 50; i++) {
        const res = await fetch("/bookmarks", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({
            url: `https://example.com/cap-e2e-${i}`,
            title: `Cap E2E Bookmark ${i}`,
          }),
        });
        if (!res.ok) {
          throw new Error(`Failed to create bookmark ${i}: ${res.status}`);
        }
      }
    });

    // ── Phase 4: Navigate to bookmarks ──────────────────────────────
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    // ── Phase 5: Verify the cap banner is shown ─────────────────────
    const capBanner = page.locator('[data-testid="bookmark-cap-banner"]');
    await expect(capBanner).toBeVisible();

    // Verify the banner contains an upgrade CTA
    await expect(capBanner).toContainText("Upgrade to Personal");
  });
});
