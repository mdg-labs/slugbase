import { test, expect } from "../../fixtures/auth.js";
import { setActiveWorkspacePlan } from "../../helpers/workspace-plan.js";

test.describe("Settings entitlement gates", () => {
  // Free vs team tests mutate the same worker workspace plan — run serially.
  test.describe.configure({ mode: "serial" });

  test("free plan shows members-plan-gate and audit-plan-gate", async ({
    authedPage,
    sessionCookie,
    csrfToken,
  }) => {
    const page = authedPage;

    await setActiveWorkspacePlan(page, sessionCookie, csrfToken, "free");

    await page.goto("/settings/members");
    await page.waitForSelector('[data-testid="settings-layout"]');

    await expect(page.locator('[data-testid="members-plan-gate"]')).toBeVisible();

    await page.goto("/settings/audit");
    await page.waitForSelector('[data-testid="settings-layout"]');

    await expect(page.locator('[data-testid="audit-plan-gate"]')).toBeVisible();
  });

  test("team plan shows members and audit pages (no plan gates)", async ({
    authedPage,
    sessionCookie,
    csrfToken,
  }) => {
    test.setTimeout(60_000);

    const page = authedPage;

    await setActiveWorkspacePlan(page, sessionCookie, csrfToken, "team");

    await page.goto("/settings/members");
    await page.waitForSelector('[data-testid="members-settings-page"]');

    await expect(page.locator('[data-testid="members-plan-gate"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="members-settings-page"]')).toBeVisible();

    // Re-assert team plan — parallel specs on the same worker may downgrade to free.
    await setActiveWorkspacePlan(page, sessionCookie, csrfToken, "team");

    await page.goto("/settings/audit");
    await page.waitForSelector('[data-testid="audit-log-page"]');

    await expect(page.locator('[data-testid="audit-plan-gate"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="audit-log-page"]')).toBeVisible();
  });
});
