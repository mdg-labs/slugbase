import { generateSecret, generateSync } from "otplib";
import { test, expect, getWorkerCredentials } from "../../fixtures/auth.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

test.describe("MFA enroll and challenge flow", () => {
  test("enroll TOTP in settings -> logout -> login requires MFA challenge", async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    // ── Phase 1: Login via form ────────────────────────────────────
    await loginAsWorker(page, testInfo.workerIndex);

    // ── Phase 2: Navigate to MFA enroll page ──────────────────────
    await page.goto("/mfa/enroll");
    await page.waitForSelector('[data-testid="mfa-enroll-section"]');

    // Verify QR code is displayed
    await page.waitForSelector('[data-testid="mfa-qr-code"]');
    const qrCode = page.locator('[data-testid="mfa-qr-code"]');
    await expect(qrCode).toBeVisible();
    const qrSrc = await qrCode.getAttribute("src");
    expect(qrSrc).toContain("data:image/png;base64,");

    // ── Phase 3: Reveal the TOTP text secret ──────────────────────
    // Click the "manual code" toggle button to reveal the secret
    await page.click('[data-testid="mfa-text-secret-toggle"]');
    await page.waitForSelector('[data-testid="mfa-setup-code"]');
    const textSecret = await page.locator('[data-testid="mfa-setup-code"]').textContent();
    expect(textSecret).toBeTruthy();
    expect(textSecret!.length).toBeGreaterThan(0);

    // ── Phase 4: Generate TOTP and verify enrollment ──────────────
    // Retry on TOTP window boundaries — first verify can fail on cold CI runners.
    let enrolled = false;
    for (let attempt = 0; attempt < 3 && !enrolled; attempt++) {
      const totpCode = generateSync({ secret: textSecret!.trim() });
      const digitInputs = page.locator('[data-testid="mfa-verify-input"] input');
      const digits = totpCode.split("");
      for (let i = 0; i < digits.length; i++) {
        await digitInputs.nth(i).fill(digits[i]);
      }
      await page.click('[data-testid="mfa-verify-submit"]');
      try {
        await page.waitForSelector('[data-testid="mfa-backup-codes"]', { timeout: 20_000 });
        enrolled = true;
      } catch {
        // stale code or slow API — retry with a fresh TOTP
      }
    }
    expect(enrolled).toBe(true);

    // ── Phase 5: Backup codes are shown ───────────────────────────
    const backupCodesSection = page.locator('[data-testid="mfa-backup-codes"]');
    await expect(backupCodesSection).toBeVisible();

    // ── Phase 6: Logout ───────────────────────────────────────────
    await page.goto("/logout");
    await page.waitForURL(/\/login/);
    await page.waitForSelector('[data-testid="login-form"]');

    // ── Phase 7: Login again — should require MFA challenge ────────
    const { email: mfaEmail, password: mfaPassword } = getWorkerCredentials(testInfo.workerIndex);
    await page.fill('[data-testid="login-email-input"]', mfaEmail);
    await page.fill('[data-testid="login-password-input"]', mfaPassword);
    await page.locator('[data-testid="login-submit-btn"] button[type="submit"]').click();

    // Should be redirected to MFA challenge page
    await page.waitForURL(/\/mfa$/);
    await page.waitForSelector('[data-testid="mfa-challenge-form"]');

    // ── Phase 8: Complete MFA challenge with TOTP ─────────────────
    const newTotpCode = generateSync({ secret: textSecret!.trim() });
    const challengeInputs = page.locator('[data-testid="mfa-code-input"] input');
    const challengeDigits = newTotpCode.split("");
    for (let i = 0; i < challengeDigits.length; i++) {
      await challengeInputs.nth(i).fill(challengeDigits[i]);
    }
    await page.click('[data-testid="mfa-submit-btn"]');

    // Should reach the dashboard
    await page.waitForURL(/\/$/);
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // ── Phase 9: Cleanup — disable MFA so subsequent tests are unaffected ──
    // Use page.evaluate so the fetch runs in the browser context where the
    // session cookie is established. The web app proxies /auth/* to the backend.
    const cleanupTotp = generateSync({ secret: textSecret!.trim() });
    const disableRes = await page.evaluate(async (code) => {
      const res = await fetch("/auth/mfa/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totpCode: code }),
      });
      return { ok: res.ok, status: res.status };
    }, cleanupTotp);
    expect(disableRes.ok).toBeTruthy();
  });
});