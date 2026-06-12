import { test, expect } from "../../fixtures/auth.js";

/**
 * Self-hosted operator surfaces (spec §11.3–§11.5, §12.4).
 * Runs only on the `self-hosted` Playwright project — see SELF_HOSTED_ONLY_SPECS
 * in playwright.config.ts. Worker accounts are bootstrapped via public
 * registration (PUBLIC_REGISTRATION=true in scripts/e2e.sh; prod default false).
 */
test.describe("Self-hosted operator settings", () => {
  test("members and audit accessible without plan upgrade", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/settings/members");
    await page.waitForSelector('[data-testid="settings-layout"]');

    await expect(page.locator('[data-testid="members-plan-gate"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="members-settings-page"]')).toBeVisible();

    await page.goto("/settings/audit");
    await page.waitForSelector('[data-testid="settings-layout"]');

    await expect(page.locator('[data-testid="audit-plan-gate"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="audit-log-page"]')).toBeVisible();
  });

  test("workspace settings show SMTP, OIDC, and AI BYO sections", async ({
    authedPage,
  }) => {
    const page = authedPage;

    await page.goto("/settings/workspace");
    await page.waitForSelector('[data-testid="settings-layout"]');

    await expect(page.locator('a[href="/settings/workspace?section=smtp"]')).toBeVisible();
    await expect(page.locator('a[href="/settings/workspace?section=oidc"]')).toBeVisible();
    await expect(page.locator('a[href="/settings/workspace?section=ai"]')).toBeVisible();

    await page.goto("/settings/workspace?section=smtp");
    await page.waitForSelector('[data-testid="workspace-settings-page"]');
    await expect(page.locator('[data-testid="workspace-operator-managed-gate"]')).not.toBeVisible();

    await page.goto("/settings/workspace?section=oidc");
    await page.waitForSelector('[data-testid="workspace-settings-page"]');
    await expect(page.locator('[data-testid="workspace-operator-managed-gate"]')).not.toBeVisible();

    await page.goto("/settings/workspace?section=ai");
    await page.waitForSelector('[data-testid="workspace-settings-page"]');
    await expect(page.locator('[data-testid="workspace-operator-managed-gate"]')).not.toBeVisible();
  });

  test("billing settings show unavailable gate", async ({ authedPage }) => {
    const page = authedPage;

    await page.goto("/settings/billing");
    await page.waitForSelector('[data-testid="settings-layout"]');

    await expect(page.locator('[data-testid="billing-unavailable-gate"]')).toBeVisible();
    await expect(page.locator('[data-testid="billing-settings-page"]')).not.toBeVisible();
  });

  test("no bookmark cap banner or sidebar usage meter on default workspace", async ({
    authedPage,
  }) => {
    const page = authedPage;

    await page.goto("/");
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    await expect(page.locator('[data-testid="bookmark-cap-banner"]')).not.toBeVisible();

    const sidebarFooter = page.locator('[data-testid="sidebar-user-menu"]');
    await expect(sidebarFooter.getByText(/\d+\s*\/\s*\d+/)).not.toBeVisible();
  });
});
