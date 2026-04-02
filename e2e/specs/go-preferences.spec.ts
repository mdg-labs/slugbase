/**
 * Go preferences: page loads; empty state or list after using /go (covered elsewhere).
 */
import { test, expect } from '@playwright/test';

test.describe('Go preferences', () => {
  test('loads remembered slug choices page', async ({ page }) => {
    await page.goto('/go-preferences');

    await expect(
      page.getByRole('heading', { level: 1, name: /Remembered Slug Choices/i })
    ).toBeVisible({ timeout: 10000 });

    await expect(
      page.getByText(/No saved preferences|\/go\//i).first()
    ).toBeVisible({ timeout: 5000 });
  });
});
