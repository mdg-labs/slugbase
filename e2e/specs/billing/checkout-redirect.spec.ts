import { test, expect } from "../../fixtures/auth.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

test.describe("Billing checkout redirect", () => {
  test("start checkout and intercept external Stripe URL", async ({
    page,
  }, testInfo) => {
    // ── Phase 1: Login ──────────────────────────────────────────────
    await loginAsWorker(page, testInfo.workerIndex);

    // ── Phase 2: Navigate to billing settings ───────────────────────
    await page.goto("/settings/billing");
    await page.waitForSelector('[data-testid="settings-layout"]');

    // ── Phase 3: Check billing availability ────────────────────────
    // billing-unavailable-gate is shown when VITE_BILLING_ENABLED=false
    // (build-time flag). Skip the interactive test when billing UI is
    // not available — the plan table / checkout CTA won't be rendered.
    const unavailableGate = page.locator('[data-testid="billing-unavailable-gate"]');
    const billingPage = page.locator('[data-testid="billing-settings-page"]');

    // Test one of the two states
    if ((await unavailableGate.count()) > 0 && (await unavailableGate.first().isVisible())) {
      // Billing UI is not built — verify the gate is rendered correctly
      await expect(unavailableGate).toBeVisible();
      return;
    }

    // Wait for the billing page to load
    await page.waitForSelector('[data-testid="billing-settings-page"]');
    await page.waitForSelector('[data-testid="billing-plan-table"]');

    // ── Phase 4: Intercept checkout API → return mock Stripe URL ───
    let checkoutUrlCaptured = "";
    await page.route("**/workspaces/*/billing/checkout", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const url = "https://checkout.stripe.com/c/pay/test_e2e_checkout_session";
      checkoutUrlCaptured = url;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          checkoutUrl: url,
          sessionId: "cs_test_e2e",
        }),
      });
    });

    // ── Phase 5: Block external navigation to Stripe ───────────────
    await page.route("https://checkout.stripe.com/**", async (route) => {
      await route.abort();
    });

    // ── Phase 6: Click an upgrade button in the plan table ─────────
    // The plan table shows upgrade CTAs for plans above the current one.
    const upgradeBtn = page
      .locator('[data-testid="billing-plan-table"] button:not([disabled])')
      .first();
    await expect(upgradeBtn).toBeVisible();
    await upgradeBtn.click();

    // ── Phase 7: Wait for checkout API call and verify URL ──────────
    await page.waitForTimeout(2000);
    expect(checkoutUrlCaptured).toContain("checkout.stripe.com");

    // ── Phase 8: Clean up routes ────────────────────────────────────
    await page.unroute("**/workspaces/*/billing/checkout");
    await page.unroute("https://checkout.stripe.com/**");
  });
});