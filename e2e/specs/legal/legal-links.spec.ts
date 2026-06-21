import { test, expect } from '../../fixtures/auth.js';
import { getWorkerCredentials } from '../../fixtures/auth.js';
import {
  isCloudE2eProject,
  isCeE2eProject,
} from '../../helpers/deployment-project.js';

test.describe('Legal links visibility', () => {
  test('auth shell legal links follow deployment mode', async ({ page }, testInfo) => {
    await page.goto('/login');
    await page.waitForSelector('[data-testid="login-form"]');

    if (isCloudE2eProject(testInfo)) {
      const legalLinks = page.getByTestId('legal-links');
      await expect(legalLinks).toBeVisible();
      await expect(page.getByTestId('legal-link-impressum')).toBeVisible();
      await expect(page.getByTestId('legal-link-datenschutz')).toBeVisible();
      await expect(page.getByTestId('legal-link-agb')).toBeVisible();

      const impressumHref = await page.getByTestId('legal-link-impressum').getAttribute('href');
      expect(impressumHref).toMatch(/\/legal\/impressum$/);
      await expect(page.getByTestId('legal-link-impressum')).toHaveAttribute('target', '_blank');
      await expect(page.getByTestId('legal-link-impressum')).toHaveAttribute(
        'rel',
        'noopener noreferrer',
      );
      return;
    }

    if (isCeE2eProject(testInfo)) {
      await expect(page.getByTestId('legal-links')).toHaveCount(0);
    }
  });

  test('sidebar legal links follow deployment mode', async ({ page }, testInfo) => {
    const { email, password } = getWorkerCredentials(testInfo.workerIndex);

    await page.goto('/login');
    await page.fill('[data-testid="login-email-input"]', email);
    await page.fill('[data-testid="login-password-input"]', password);
    await page.click('[data-testid="login-submit-btn"]');
    await page.waitForURL(/\/$/);
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    if (isCloudE2eProject(testInfo)) {
      const sidebarFooter = page.getByTestId('sidebar-user-menu');
      await expect(sidebarFooter.getByTestId('legal-links')).toBeVisible();
      await expect(sidebarFooter.getByTestId('legal-link-impressum')).toBeVisible();
      return;
    }

    if (isCeE2eProject(testInfo)) {
      await expect(page.getByTestId('legal-links')).toHaveCount(0);
    }
  });
});
