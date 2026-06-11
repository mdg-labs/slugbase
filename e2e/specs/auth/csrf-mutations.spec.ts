import { test, expect } from "../../fixtures/auth.js";

test.describe("CSRF mutations", () => {
  test("mutating request without CSRF fails; with token succeeds via browser", async ({
    page,
  }) => {
    // ── Phase 1: Login and reach dashboard ────────────────────────
    await page.goto("/login");
    await page.waitForSelector('[data-testid="login-form"]');
    await page.fill('[data-testid="login-email-input"]', "e2e@slugbase.test");
    await page.fill('[data-testid="login-password-input"]', "e2e-test-password");
    await page.click('[data-testid="login-submit-btn"]');
    await page.waitForURL(/\/$/);
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // ── Phase 2: Try a mutation without CSRF token ────────────────
    // Use PATCH /auth/account/profile which is CSRF-protected (no @SkipCsrf).
    // The session cookie is auto-sent by the browser on same-origin requests
    // via the React Router proxy (/auth/* -> backend).
    const noCsrfResult = await page.evaluate(async () => {
      try {
        const res = await fetch("/auth/account/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "CSRF Test No Token" }),
        });
        return { status: res.status, ok: res.ok };
      } catch {
        return { status: 0, ok: false, error: "network_error" };
      }
    });

    // Without CSRF token, the request should be rejected with 403
    expect(noCsrfResult.status).toBe(403);

    // ── Phase 3: Get a CSRF token ─────────────────────────────────
    const csrfResult = await page.evaluate(async () => {
      const res = await fetch("/auth/csrf-token");
      const data = (await res.json()) as { csrfToken: string };
      return { token: data.csrfToken };
    });
    expect(csrfResult.token).toBeTruthy();
    const csrfToken = csrfResult.token;

    // The CSRF cookie was set by the server (httpOnly: false).
    // Read it from document.cookie and verify it matches the token.
    const csrfCookie = await page.evaluate(() => {
      const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
      return match ? match[1] : null;
    });
    expect(csrfCookie).toBeTruthy();
    expect(csrfCookie).toBe(csrfToken);

    // ── Phase 4: Try the same mutation WITH the CSRF token ────────
    const withCsrfResult = await page.evaluate(
      async (token: string) => {
        try {
          const res = await fetch("/auth/account/profile", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "x-csrf-token": token,
            },
            body: JSON.stringify({ name: "CSRF Test With Token" }),
          });
          return { status: res.status, ok: res.ok };
        } catch {
          return { status: 0, ok: false, error: "network_error" };
        }
      },
      csrfToken,
    );

    // With the CSRF token, the request should succeed (2xx)
    expect(withCsrfResult.status).toBeGreaterThanOrEqual(200);
    expect(withCsrfResult.status).toBeLessThan(300);

    // ── Phase 5: Restore the original name (cleanup) ─────────────
    await page.evaluate(
      async (token: string) => {
        try {
          await fetch("/auth/account/profile", {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "x-csrf-token": token,
            },
            body: JSON.stringify({ name: "E2E Test User" }),
          });
        } catch {
          // Best-effort cleanup
        }
      },
      csrfToken,
    );
  });
});