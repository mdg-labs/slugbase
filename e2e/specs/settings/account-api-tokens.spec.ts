import { test, expect } from "../../fixtures/auth.js";

test.describe("Account API tokens", () => {
  test("create API token and verify shown-once panel displays", async ({
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

    // ── Phase 2: Navigate to account settings (tokens section) ─────
    await page.goto("/settings/account?section=tokens");
    await page.waitForSelector('[data-testid="settings-layout"]');
    await page.waitForSelector('[data-testid="account-settings-page"]');

    // ── Phase 3: Wait for the api-tokens-section testid ────────────
    const section = page.locator('[data-testid="api-tokens-section"]');
    await expect(section).toBeVisible();

    // ── Phase 4: Intercept the token creation API ───────────────────
    await page.route("**/auth/api-tokens", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          token: {
            id: "e2e-test-token-id",
            name: "E2E Test Token",
            lastUsedAt: null,
            createdAt: new Date().toISOString(),
            expiresAt: null,
          },
          plaintext: "sb_test_e2e_plaintext_secret",
        }),
      });
    });

    // ── Phase 5: Click "New token" button to open the create form ──
    // Find the "New" or "Create" button that sets creating=true.
    const newTokenBtn = page.locator(
      '[data-testid="api-tokens-section"] button',
    );
    await expect(newTokenBtn.first()).toBeVisible();
    await newTokenBtn.first().click();

    // ── Phase 6: Fill in the token name ─────────────────────────────
    const nameInput = page.locator('[data-testid="api-token-name-input"]');
    await expect(nameInput).toBeVisible();
    await nameInput.fill("E2E Test Token");

    // ── Phase 7: Click the create button ────────────────────────────
    const createBtn = page.locator('[data-testid="api-token-create-btn"]');
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    // ── Phase 8: Verify the shown-once panel appears ────────────────
    const plaintextPanel = page.locator(
      '[data-testid="api-token-plaintext-panel"]',
    );
    await expect(plaintextPanel).toBeVisible();

    // Verify the secret is displayed in the panel
    await expect(plaintextPanel).toContainText("sb_test_e2e_plaintext_secret");

    // ── Phase 9: Clean up routes ────────────────────────────────────
    await page.unroute("**/auth/api-tokens");
  });
});