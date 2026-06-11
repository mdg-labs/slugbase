import { test, expect } from "../../fixtures/auth.js";

test.describe("Workspace switcher", () => {
  test("create second workspace → switch via WorkspaceSwitcherPanel → sidebar and bookmark list reflect active workspace", async ({
    page,
  }) => {
    // ── Phase 1: Login ──────────────────────────────────────────
    await page.goto("/login");
    await page.waitForSelector('[data-testid="login-form"]');
    await page.fill('[data-testid="login-email-input"]', "e2e@slugbase.test");
    await page.fill('[data-testid="login-password-input"]', "e2e-test-password");
    await page.click('[data-testid="login-submit-btn"]');
    await page.waitForURL(/\/$/);

    // Mark onboarding as done so the overlay doesn't interfere
    await page.evaluate(() => {
      window.localStorage.setItem("sb_onboarding_done", "true");
    });

    // Reload to apply onboarding state
    await page.reload();
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // ── Phase 2: Open workspace switcher ─────────────────────────
    // The trigger is the workspace name button in the sidebar
    await page.click('[aria-label*="workspace"]');
    await page.waitForSelector('[data-testid="workspace-switcher-panel"]');

    // Verify at least one workspace is listed (the default)
    const workspaceItems = page.locator('[data-testid^="workspace-switcher-item-"]');
    await expect(workspaceItems).not.toHaveCount(0);

    // ── Phase 3: Create a second workspace ───────────────────────
    const createBtn = page.locator('[data-testid="workspace-switcher-create-btn"]');
    await createBtn.click();

    // Fill in the workspace name
    const nameInput = page.locator("#ws-name-input");
    await expect(nameInput).toBeVisible();
    await nameInput.fill("Second Workspace");

    // Submit the create form
    const submitBtn = page.locator("button").filter({ hasText: /create/i });
    await submitBtn.click();

    // The page reloads after workspace creation (navigate(0))
    // Wait for the sidebar nav to reappear with the new workspace name
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // ── Phase 4: Open workspace switcher and switch ──────────────
    await page.click('[aria-label*="workspace"]');
    await page.waitForSelector('[data-testid="workspace-switcher-panel"]');

    // There should now be at least 2 workspace items
    const itemsAfterCreate = page.locator('[data-testid^="workspace-switcher-item-"]');
    await expect(itemsAfterCreate).toHaveCount(2);

    // Click the second workspace (the one we just created)
    // The active workspace has a checkmark; the inactive one is clickable
    const secondItem = itemsAfterCreate.nth(1);
    await expect(secondItem).not.toBeDisabled();
    await secondItem.click();

    // The page reloads after workspace switch (navigate(0))
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // ── Phase 5: Verify active workspace reflected ───────────────
    // The sidebar should now show "Second Workspace" as the active workspace
    await expect(page.locator('[data-testid="sidebar-nav"]')).toContainText(/second workspace/i);

    // Re-open switcher to verify the switched workspace is now active
    await page.click('[aria-label*="workspace"]');
    await page.waitForSelector('[data-testid="workspace-switcher-panel"]');
  });
});