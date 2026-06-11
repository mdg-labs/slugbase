import { test, expect } from "../../fixtures/auth.js";

test.describe("Billing portal redirect", () => {
  test("click manage subscription and intercept portal URL", async ({
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

    // ── Phase 2: Navigate to billing settings ───────────────────────
    await page.goto("/settings/billing");
    await page.waitForSelector('[data-testid="settings-layout"]');

    // ── Phase 3: Check billing availability ────────────────────────
    const unavailableGate = page.locator('[data-testid="billing-unavailable-gate"]');

    if ((await unavailableGate.count()) > 0 && (await unavailableGate.first().isVisible())) {
      // Billing UI is not built in this build — verify the gate is rendered correctly
      await expect(unavailableGate).toBeVisible();
      return;
    }

    // Wait for the billing page to load
    await page.waitForSelector('[data-testid="billing-settings-page"]');

    // ── Phase 4: Ensure the workspace has billing fields so the
    // portal section is reachable. Set team plan + customer fields. ──
    await page.evaluate(async () => {
      const getCsrfToken = async (): Promise<string> => {
        const res = await fetch("/auth/csrf-token");
        const data = (await res.json()) as { csrfToken: string };
        return data.csrfToken;
      };
      const csrf = await getCsrfToken();

      await fetch("/workspaces/active", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({
          plan: "team",
          billingCustomerId: "cus_test_e2e_portal",
          billingSubscriptionId: "sub_test_e2e_portal",
          billingStatus: "active",
          planSeats: 5,
        }),
      });
    });

    // ── Phase 5: Intercept portal API response ─────────────────────
    let portalUrlCaptured = "";
    await page.route("**/workspaces/*/billing/portal", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const url = "https://billing.stripe.com/session/test_portal_session";
      portalUrlCaptured = url;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ portalUrl: url }),
      });
    });

    // ── Phase 6: Block external navigation to Stripe portal ─────────
    await page.route("https://billing.stripe.com/**", async (route) => {
      await route.abort();
    });

    // ── Phase 7: Navigate to the history tab (has portal button) ────
    // The billing history section has a "Manage billing" portal button
    // when billingCustomerId is set.
    const historyTab = page.locator('[data-testid="billing-settings-page"] button', {
      hasText: "History",
    });
    if ((await historyTab.count()) > 0) {
      await historyTab.first().click();
    }

    // Wait for the history section
    await page.waitForTimeout(500);

    // ── Phase 8: Click the portal button ───────────────────────────
    const portalBtn = page.locator(
      '[data-testid="billing-history-section"] button',
    );
    if ((await portalBtn.count()) > 0) {
      await portalBtn.first().click();
    } else {
      // Fallback: reload and find any portal trigger in the billing page
      await page.reload();
      await page.waitForSelector('[data-testid="billing-settings-page"]');

      // Check if the cancel panel's portal flow triggers
      const cancelPanel = page.locator('[data-testid="billing-cancel-panel"]');
      if ((await cancelPanel.count()) > 0 && (await cancelPanel.first().isVisible())) {
        // Two-step cancel: first opens portal
        const btns = cancelPanel.first().locator("button");
        await btns.first().click();
        await page.waitForTimeout(300);
        await btns.first().click();
      }
    }

    // ── Phase 9: Verify portal URL was captured ─────────────────────
    await page.waitForTimeout(1500);
    expect(portalUrlCaptured).toContain("billing.stripe.com");

    // ── Phase 10: Clean up routes ───────────────────────────────────
    await page.unroute("**/workspaces/*/billing/portal");
    await page.unroute("https://billing.stripe.com/**");
  });
});