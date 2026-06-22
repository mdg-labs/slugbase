import { test, expect } from "../../fixtures/auth.js";

/**
 * CE operator surfaces (spec §11.3–§11.5, §12.4).
 * Runs only on the `ce` Playwright project — see CE_ONLY_SPECS in
 * playwright.config.ts. Worker accounts are bootstrapped via public
 * registration (PUBLIC_REGISTRATION=true in scripts/e2e.sh; prod default false).
 */
test.describe("CE operator settings", () => {
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

  test("workspace settings show operator-managed SMTP and OIDC gates", async ({
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
    await expect(page.locator('[data-testid="workspace-operator-managed-gate"]')).toBeVisible();
    await expect(page.getByLabel("SMTP host")).not.toBeVisible();

    await page.goto("/settings/workspace?section=oidc");
    await page.waitForSelector('[data-testid="workspace-settings-page"]');
    await expect(page.locator('[data-testid="workspace-operator-managed-gate"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Add provider" })).not.toBeVisible();

    await page.goto("/settings/workspace?section=ai");
    await page.waitForSelector('[data-testid="workspace-settings-page"]');
    await expect(page.locator('[data-testid="workspace-operator-managed-gate"]')).not.toBeVisible();
    await expect(page.getByLabel("API key")).not.toBeVisible();
    await expect(page.locator("#ai-model")).not.toBeVisible();
  });

  test("workspace AI enable toggle works with operator-configured key", async ({
    authedPage,
  }) => {
    const page = authedPage;

    await page.goto("/settings/workspace?section=ai");
    await page.waitForSelector('[data-testid="workspace-settings-page"]');

    const enableToggle = page.getByRole("checkbox", { name: "Enable AI suggestions" });
    await expect(enableToggle).toBeVisible();
    await expect(enableToggle).not.toBeChecked();

    await enableToggle.check();
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page.locator('[data-testid="toast-viewport"]')).toContainText("AI settings saved");
    await expect(page.getByText(/credential configured by the operator/)).toBeVisible();
    await expect(enableToggle).toBeChecked();
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
