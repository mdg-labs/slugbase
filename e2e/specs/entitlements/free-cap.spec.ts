import { test, expect } from "../../fixtures/auth.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

const FREE_CAP = 50;

test.describe("Free bookmark cap", () => {
  // Mutates workspace plan and bookmark count — isolate from parallel specs on the same worker.
  test.describe.configure({ mode: "serial" });

  test("free workspace at cap shows bookmark-cap-banner and upgrade CTA", async ({
    page,
  }, testInfo) => {
    // ── Phase 1: Login ──────────────────────────────────────────────
    await loginAsWorker(page, testInfo.workerIndex);

    // ── Phases 2–3: Reset plan, clear leftover bookmarks, seed to cap ─
    // Other Cloud specs on the same worker may leave bookmarks or a paid plan.
    // Bulk-delete first so the sidebar meter shows exactly 50/50 at cap.
    await page.evaluate(async (cap) => {
      const getCsrfToken = async (): Promise<string> => {
        const res = await fetch("/auth/csrf-token");
        const data = (await res.json()) as { csrfToken: string };
        return data.csrfToken;
      };

      const csrf = await getCsrfToken();

      const setPlan = async (plan: "free" | "personal") => {
        const res = await fetch("/workspaces/active", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({ plan }),
        });
        if (!res.ok) {
          throw new Error(`Failed to set workspace plan ${plan}: ${res.status}`);
        }
      };

      // Personal avoids cap errors while clearing bookmarks from prior specs.
      await setPlan("personal");

      const deleteRes = await fetch("/bookmarks/bulk/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ selectAll: true }),
      });
      if (!deleteRes.ok) {
        throw new Error(`Failed to bulk-delete bookmarks: ${deleteRes.status}`);
      }

      await setPlan("free");

      for (let i = 0; i < cap; i++) {
        const res = await fetch("/bookmarks", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({
            url: `https://example.com/cap-e2e-${String(i)}`,
            title: `Cap E2E Bookmark ${String(i)}`,
          }),
        });
        if (!res.ok) {
          throw new Error(`Failed to create bookmark ${String(i)}: ${res.status}`);
        }
      }
    }, FREE_CAP);

    // ── Phase 4: Navigate to bookmarks (reload so app-layout picks up plan + count) ─
    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');
    await page.reload();
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    // ── Phase 5: Verify the cap banner is shown ─────────────────────
    const capBanner = page.locator('[data-testid="bookmark-cap-banner"]');
    await expect(capBanner).toBeVisible();

    // Verify the banner contains an upgrade CTA
    await expect(capBanner).toContainText("Upgrade to Personal");

    // ── Phase 6: Sidebar usage meter at cap (Cloud free plan only) ─
    const sidebarFooter = page.locator('[data-testid="sidebar-user-menu"]');
    const capPattern = new RegExp(`${String(FREE_CAP)}\\s*/\\s*${String(FREE_CAP)}`);
    await expect
      .poll(async () => sidebarFooter.getByText(capPattern).isVisible())
      .toBe(true);
    await expect(sidebarFooter.getByText(/Limit reached/)).toBeVisible();
  });
});
