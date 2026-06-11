import { test, expect } from "../../fixtures/auth.js";

test.describe("Settings entitlement gates", () => {
  test("free plan shows members-plan-gate and audit-plan-gate", async ({
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

    // ── Phase 2: Navigate to members settings (free plan should gate) ─
    await page.goto("/settings/members");
    await page.waitForSelector('[data-testid="settings-layout"]');

    // Free-plan workspace → plan gate should be visible
    const membersGate = page.locator('[data-testid="members-plan-gate"]');
    await expect(membersGate).toBeVisible();

    // ── Phase 3: Navigate to audit log settings (free plan should gate) ─
    await page.goto("/settings/audit");
    await page.waitForSelector('[data-testid="settings-layout"]');

    const auditGate = page.locator('[data-testid="audit-plan-gate"]');
    await expect(auditGate).toBeVisible();
  });

  test("team plan shows members and audit pages (no plan gates)", async ({
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

    // ── Phase 2: Upgrade workspace plan to "team" via API ───────────
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
        body: JSON.stringify({ plan: "team" }),
      });
      if (!res.ok) {
        throw new Error(
          `Failed to upgrade workspace plan: ${res.status} ${await res.text()}`,
        );
      }
    });

    // ── Phase 3: Navigate to members settings — should show page ────
    await page.goto("/settings/members");
    await page.waitForSelector('[data-testid="members-settings-page"]');

    // Plan gate must NOT be present
    await expect(page.locator('[data-testid="members-plan-gate"]')).not.toBeVisible();

    // Members page content should be visible
    await expect(page.locator('[data-testid="members-settings-page"]')).toBeVisible();

    // ── Phase 4: Navigate to audit log settings — should show page ──
    await page.goto("/settings/audit");
    await page.waitForSelector('[data-testid="settings-layout"]');

    // Plan gate must NOT be present
    await expect(page.locator('[data-testid="audit-plan-gate"]')).not.toBeVisible();
  });
});