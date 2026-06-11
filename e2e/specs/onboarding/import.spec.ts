import { test, expect } from "../../fixtures/auth.js";

const NETSACE_BOOKMARKS_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><A HREF="https://example.com" ADD_DATE="1700000000">Example</A>
  <DT><A HREF="https://docs.example.com" ADD_DATE="1700000001">Docs</A>
</DL><p>`;

test.describe("Onboarding import", () => {
  test("first login shows OnboardingOverlay → upload Netscape HTML → bookmarks imported → overlay dismissed", async ({
    page,
  }) => {
    // ── Phase 1: Login ──────────────────────────────────────────
    await page.goto("/login");
    await page.waitForSelector('[data-testid="login-form"]');
    await page.fill('[data-testid="login-email-input"]', "e2e@slugbase.test");
    await page.fill('[data-testid="login-password-input"]', "e2e-test-password");
    await page.click('[data-testid="login-submit-btn"]');
    await page.waitForURL(/\/$/);

    // ── Phase 2: Onboarding overlay appears (step 1: welcome) ──
    await page.waitForSelector('[data-testid="onboarding-overlay"]');
    await expect(page.locator('[data-testid="onboarding-progress-dots"]')).toBeVisible();

    // Step 1 → Step 2: Click CTA to advance to import step
    await page.click('[data-testid="onboarding-step-cta"]');

    // ── Phase 3: Upload Netscape HTML file ──────────────────────
    const fileInput = page.locator('[data-testid="onboarding-file-input"]');
    await fileInput.setInputFiles({
      name: "bookmarks.html",
      mimeType: "text/html",
      buffer: Buffer.from(NETSACE_BOOKMARKS_HTML),
    });

    // Verify the drop zone reflects the selected file
    await expect(page.locator('[data-testid="onboarding-drop-zone"]')).toContainText(/example\.com|Example/i);

    // ── Phase 4: Import ─────────────────────────────────────────
    // Click the CTA button to trigger import
    await page.click('[data-testid="onboarding-step-cta"]');

    // Wait for import to complete (the step auto-advances after 800ms)
    // Drop zone shows success then disappears when auto-advancing to step 3
    await expect(page.locator('[data-testid="onboarding-drop-zone"]')).not.toBeVisible({ timeout: 5000 });

    // ── Phase 5: Complete remaining steps ───────────────────────
    // Step 3: Browser shortcut — click CTA to continue
    await page.click('[data-testid="onboarding-step-cta"]');

    // Step 4: Summary — click CTA to finish and dismiss overlay
    await page.click('[data-testid="onboarding-step-cta"]');

    // ── Phase 6: Verify overlay dismissed ───────────────────────
    await expect(page.locator('[data-testid="onboarding-overlay"]')).not.toBeVisible();
  });
});