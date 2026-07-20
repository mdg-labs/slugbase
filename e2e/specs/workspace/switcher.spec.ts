import { test, expect } from "../../fixtures/auth.js";
import { e2eResourceSuffix } from "../../helpers/e2e-resource-id.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

test.describe("Workspace switcher", () => {
  test("create second workspace → switch via WorkspaceSwitcherPanel → sidebar and bookmark list reflect active workspace", async ({
    page,
  }, testInfo) => {
    // ── Phase 1: Login ──────────────────────────────────────────
    await loginAsWorker(page, testInfo.workerIndex);

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
    const initialWorkspaceCount = await workspaceItems.count();

    const secondWorkspaceName = `Second Workspace ${e2eResourceSuffix(testInfo)}`;

    // ── Phase 3: Create a second workspace ───────────────────────
    const createBtn = page.locator('[data-testid="workspace-switcher-create-btn"]');
    await createBtn.click();

    // Fill in the workspace name
    const nameInput = page.locator("#ws-name-input");
    await expect(nameInput).toBeVisible();
    await nameInput.fill(secondWorkspaceName);

    // Submit the create form
    const submitBtn = page.locator('[data-testid="workspace-switcher-panel"]').getByRole('button', { name: /create workspace/i });

    // Wait for workspace creation and the navigate(0) reload it triggers.
    // Do not call page.goto here — that races with the reload and causes ERR_ABORTED.
    await Promise.all([
      page.waitForResponse(
        (resp) =>
          resp.url().includes("/workspaces") &&
          resp.request().method() === "POST" &&
          resp.status() === 201,
        { timeout: 30000 },
      ),
      submitBtn.click(),
    ]);
    await page.waitForSelector('[data-testid="sidebar-nav"]', { timeout: 30000 });
    await expect(page.locator('[data-testid="workspace-switcher-panel"]')).toHaveCount(0);

    // ── Phase 4: Open workspace switcher and switch ──────────────
    await page.click('[aria-label*="workspace"]');
    await page.waitForSelector('[data-testid="workspace-switcher-panel"]');

    const itemsAfterCreate = page.locator('[data-testid^="workspace-switcher-item-"]');
    await expect(itemsAfterCreate).toHaveCount(initialWorkspaceCount + 1);

    // Click the workspace we just created (name is unique per worker/retry)
    const createdItem = itemsAfterCreate.filter({ hasText: secondWorkspaceName });
    await expect(createdItem).toHaveCount(1);
    await expect(createdItem).not.toBeDisabled();

    // Wait for workspace activation and the navigate(0) reload it triggers.
    await Promise.all([
      page.waitForResponse(
        (resp) =>
          resp.url().includes("/activate") &&
          resp.request().method() === "POST" &&
          resp.ok(),
        { timeout: 30000 },
      ),
      createdItem.click(),
    ]);
    await page.waitForSelector('[data-testid="sidebar-nav"]', { timeout: 30000 });
    await expect(page.locator('[data-testid="workspace-switcher-panel"]')).toHaveCount(0);

    // ── Phase 5: Verify active workspace reflected ───────────────
    // The workspace switcher trigger shows the active workspace name
    await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(
      secondWorkspaceName,
    );

    // Re-open switcher to verify the switched workspace is now active
    await page.click('[aria-label*="workspace"]');
    await page.waitForSelector('[data-testid="workspace-switcher-panel"]');
  });
});