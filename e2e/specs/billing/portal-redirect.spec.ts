import { test, expect } from "../../fixtures/auth.js";

const apiUrl = () =>
  process.env.E2E_BASE_URL_API
  ?? process.env.E2E_BASE_URL_SELF_HOSTED
  ?? "http://localhost:4001";

test.describe("Billing portal redirect", () => {
  test("click manage subscription and intercept portal URL", async ({
    authedPage,
    sessionCookie,
    csrfToken,
  }) => {
    const page = authedPage;

    // Seed billing fields before loading billing UI — loader state drives portal enablement.
    const patchRes = await page.request.patch(`${apiUrl()}/workspaces/active`, {
      headers: {
        Cookie: sessionCookie,
        "x-csrf-token": csrfToken,
        "Content-Type": "application/json",
      },
      data: {
        plan: "team",
        billingCustomerId: "cus_test_e2e_portal",
        billingSubscriptionId: "sub_test_e2e_portal",
        billingStatus: "active",
        planSeats: 5,
      },
    });
    expect(patchRes.ok(), `Billing seed failed: ${patchRes.status()}`).toBeTruthy();

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

    await page.route("https://billing.stripe.com/**", async (route) => {
      await route.abort();
    });

    await page.goto("/settings/billing?tab=history");
    await page.waitForSelector('[data-testid="settings-layout"]');

    const unavailableGate = page.locator('[data-testid="billing-unavailable-gate"]');
    if ((await unavailableGate.count()) > 0 && (await unavailableGate.first().isVisible())) {
      await expect(unavailableGate).toBeVisible();
      return;
    }

    await page.waitForSelector('[data-testid="billing-history-section"]');

    const portalBtn = page.locator(
      '[data-testid="billing-history-section"] button:not([disabled])',
    );
    await expect(portalBtn).toBeVisible();
    await portalBtn.click();

    await expect.poll(() => portalUrlCaptured).toContain("billing.stripe.com");

    await page.unroute("**/workspaces/*/billing/portal");
    await page.unroute("https://billing.stripe.com/**");
  });
});
