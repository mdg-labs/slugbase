import { test, expect } from '@playwright/test';

test.describe('Self-hosted setup smoke', () => {
  test('fresh DB shows /setup flow and setup completes session', async ({ page }) => {
    // Navigate to setup page (self-hosted mode: requires fresh DB via E2E_SETUP_MODE)
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

    // After setup, should redirect to login (or be signed in directly)
    // The spec says "complete setup → session" which means user may
    // be redirected to login or directly to dashboard
    await page.waitForURL(/\/(login)?$/);
  });
});