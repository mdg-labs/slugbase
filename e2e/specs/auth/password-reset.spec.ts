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
   * Register a dedicated test user.
   * Skipped in self-hosted mode (public registration disabled).
   */
  test.beforeAll(async ({ request }) => {
    // Skip in self-hosted — no public registration
    if (process.env.E2E_BASE_URL_SELF_HOSTED && !process.env.E2E_BASE_URL_API) {
      test.skip();
      return;
    }

    const apiUrl = process.env["E2E_BASE_URL_API"] ?? "http://localhost:4001";
    const res = await request.post(`${apiUrl}/auth/register`, {
      data: { email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME },
    });
    expect(res.ok(), `Registration failed: ${res.status()} ${res.statusText()}`).toBeTruthy();
  });

  test("forgot password -> reset link -> login with new password", async ({ page }) => {
    // Skip in self-hosted — no public registration
    if (process.env.E2E_BASE_URL_SELF_HOSTED && !process.env.E2E_BASE_URL_API) {
      test.skip();
      return;
    }

    // Phase 1: Forgot password page
    await page.goto("/forgot-password");
    await page.waitForSelector('[data-testid="forgot-password-form"]');

    // Phase 2: Submit email
    await page.fill('[data-testid="forgot-password-email-input"]', TEST_EMAIL);
    await page.click('[data-testid="forgot-password-submit-btn"]');
    await expect(page.locator("text=Check your email")).toBeVisible({ timeout: 10000 });

    // Phase 3: Extract reset token from DB
    const databaseUrl = process.env["DATABASE_URL"];
    expect(databaseUrl, "DATABASE_URL must be set for password-reset e2e").toBeTruthy();
    const sql = postgres(databaseUrl!);

    let knownToken: string;
    try {
      const users = await sql<Array<{ id: string }>>`SELECT id FROM user_accounts WHERE email = ${TEST_EMAIL} LIMIT 1`;
      expect(users.length).toBe(1, "Test user must exist");
      const userId = users[0].id;

      await sql`DELETE FROM password_reset_tokens WHERE user_id = ${userId}`;

      knownToken = "e2e-reset-token-known-plaintext-128bit";
      const tokenHash = createHash("sha256").update(knownToken).digest("hex");

      await sql`
        INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
        VALUES (${randomUUID()}, ${userId}, ${tokenHash}, ${Date.now() + 3600_000}, ${Date.now()})
      `;
    } finally {
      await sql.end();
    }

    // Phase 4: Reset password with the token
    await page.goto(`/reset-password?token=${knownToken}`);
    await page.waitForSelector('[data-testid="reset-password-form"]');

    // Phase 5: Fill in new password
    await page.fill('[data-testid="reset-password-input"]', NEW_PASSWORD);
    await page.fill("#confirmPassword", NEW_PASSWORD);
    await page.click('[data-testid="reset-password-submit-btn"]');

    // Should redirect to /login?reset=success
    await page.waitForURL(/\/login/);
    expect(page.url()).toContain("reset=success");

    // Phase 6: Login with the new password
    await page.waitForSelector('[data-testid="login-form"]');
    await page.fill('[data-testid="login-email-input"]', TEST_EMAIL);
    await page.fill('[data-testid="login-password-input"]', NEW_PASSWORD);
    await page.click('[data-testid="login-submit-btn"]');

    await page.waitForURL(/\/$/);
    await page.waitForSelector('[data-testid="sidebar-nav"]');
  });
});
