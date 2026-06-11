import { randomBytes, createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { test, expect } from "../../fixtures/auth.js";

test.describe("Password reset flow", () => {
  const PREFIX = `pwreset-${randomBytes(4).toString("hex")}`;
  const TEST_EMAIL = `${PREFIX}@slugbase.test`;
  const TEST_PASSWORD = "pwreset-test-password-123!";
  const TEST_NAME = "PW Reset Test User";
  const NEW_PASSWORD = "new-strong-password-456!";

  /**
   * Register a dedicated test user so we don't interfere with parallel tests
   * that use the shared `e2e@slugbase.test` account.
   */
  test.beforeAll(async ({ page }) => {
    // Use the registration API to create a dedicated test user
    const apiUrl =
      process.env["E2E_BASE_URL_API"] ?? "http://localhost:4001";
    const res = await page.request.post(`${apiUrl}/auth/register`, {
      data: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: TEST_NAME,
      },
    });
    expect(
      res.ok(),
      `Registration failed: ${res.status()} ${res.statusText()}`,
    ).toBeTruthy();
  });

  test("forgot password -> reset link -> login with new password", async ({
    page,
  }) => {
    // ── Phase 1: Navigate to forgot password page ────────────────
    await page.goto("/forgot-password");
    await page.waitForSelector('[data-testid="forgot-password-form"]');

    // ── Phase 2: Submit email ────────────────────────────────────
    await page.fill(
      '[data-testid="forgot-password-email-input"]',
      TEST_EMAIL,
    );
    await page.click('[data-testid="forgot-password-submit-btn"]');

    // Non-enumerating: always shows success regardless of backend
    await expect(page.locator("text=Check your email")).toBeVisible({
      timeout: 10000,
    });

    // ── Phase 3: Extract reset token from the database ───────────
    // No real email transport in e2e, so we read/create a token directly
    // in Postgres to simulate what the user would receive via email.
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      "postgresql://slugbase:slugbase@localhost:5432/slugbase_e2e";

    const sql = postgres(databaseUrl);

    let knownToken: string;
    try {
      // Get the user ID matching our test email
      const users = await sql<
        Array<{ id: string }>
      >`SELECT id FROM accounts WHERE email = ${TEST_EMAIL} LIMIT 1`;
      expect(users.length).toBe(1, "Test user must exist");
      const userId = users[0].id;

      // Delete any auto-generated tokens for this user (created by the
      // forgot-password handler above)
      await sql`DELETE FROM password_reset_tokens WHERE user_id = ${userId}`;

      // Create a token with a known plaintext so we can use it in the UI
      knownToken = "e2e-reset-token-known-plaintext-128bit";
      const tokenHash = createHash("sha256")
        .update(knownToken)
        .digest("hex");

      await sql`
        INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
        VALUES (
          ${randomUUID()},
          ${userId},
          ${tokenHash},
          ${Date.now() + 3600_000},
          ${Date.now()}
        )
      `;
    } finally {
      await sql.end();
    }

    // ── Phase 4: Navigate to reset-password page with the token ──
    await page.goto(`/reset-password?token=${knownToken}`);
    await page.waitForSelector('[data-testid="reset-password-form"]');

    // ── Phase 5: Fill in new password ────────────────────────────
    await page.fill('[data-testid="reset-password-input"]', NEW_PASSWORD);

    // Also fill the confirm password field (no testid, use id selector)
    await page.fill("#confirmPassword", NEW_PASSWORD);

    await page.click('[data-testid="reset-password-submit-btn"]');

    // Should redirect to /login?reset=success
    await page.waitForURL(/\/login/);
    expect(page.url()).toContain("reset=success");

    // ── Phase 6: Login with the new password ─────────────────────
    await page.waitForSelector('[data-testid="login-form"]');
    await page.fill('[data-testid="login-email-input"]', TEST_EMAIL);
    await page.fill('[data-testid="login-password-input"]', NEW_PASSWORD);
    await page.click('[data-testid="login-submit-btn"]');

    // Should reach the dashboard
    await page.waitForURL(/\/$/);
    await page.waitForSelector('[data-testid="sidebar-nav"]');
  });
});