import { test, expect } from '@playwright/test';

const apiUrl =
  process.env.E2E_BASE_URL_API ??
  process.env.E2E_BASE_URL_CE ??
  'http://localhost:4001';

test.describe('CE setup smoke', () => {
  test('fresh DB shows /setup flow and setup completes session', async ({ page }) => {
    // globalSetup already called /setup/complete — if setup is done, skip
    const statusRes = await page.request.get(`${apiUrl}/setup/status`);
    if (statusRes.ok()) {
      const status = (await statusRes.json()) as { needsSetup?: boolean };
      if (status.needsSetup === false) {
        test.skip(true, 'Setup already completed by globalSetup');
        return;
      }
    }

    // Navigate to setup page (CE mode: fresh DB)
    await page.goto('/setup');

    // The setup page should render with the setup form
    await page.waitForSelector('form[method="post"]');

    // Fill in admin details
    await page.fill('#name', 'Admin User');
    await page.fill('#email', 'admin@slugbase.test');
    await page.fill('#password', 'strong-password-123!');

    // Fill in workspace details
    await page.fill('#workspaceName', 'My Workspace');

    // The slug is auto-derived. Verify it.
    const slugInput = page.locator('#workspaceSlug');
    await expect(slugInput).toHaveValue(/my-workspace/i);

    // Submit the setup form
    await page.click('button[type="submit"]');

    // After setup, redirect to app shell with session established (HTTP-safe cookies)
    await page.waitForURL(/\/$/);
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'slb_session');
    expect(session).toBeDefined();
    expect(session?.secure).toBe(false);
  });
});
