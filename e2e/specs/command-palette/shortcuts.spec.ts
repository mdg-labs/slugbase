import { test, expect } from '../../fixtures/auth.js';

test.describe('Command palette shortcuts', () => {
  test('quick actions (new bookmark) visible when palette is empty', async ({ authedPage }) => {
    const page = authedPage;

    // Navigate to the app root
    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // Open command palette with ⌘K
    await page.keyboard.press('Control+k');
    await page.waitForSelector('[data-testid="command-palette-dialog"]');
    await page.waitForSelector('[data-testid="command-palette-input"]');

    // The input should be empty and the palette should display action groups
    const input = page.locator('[data-testid="command-palette-input"]');
    const inputValue = await input.inputValue();
    expect(inputValue).toBe('');

    // Quick actions should be visible: "New Bookmark" with hint "C"
    const palette = page.locator('[data-testid="command-palette-dialog"]');
    await expect(palette.getByText('New Bookmark', { exact: false }).first()).toBeVisible({ timeout: 3000 });
    // "New Folder" should also be visible with hint "F"
    await expect(palette.getByText('New Folder', { exact: false }).first()).toBeVisible({ timeout: 3000 });
    // Navigation actions should be visible
    await expect(palette.getByText('Go to Bookmarks', { exact: false }).first()).toBeVisible({ timeout: 3000 });
    await expect(palette.getByText('Go to Settings', { exact: false }).first()).toBeVisible({ timeout: 3000 });

    // Verify the shortcut hint "C" for new bookmark is rendered inside the palette
    const kbdC = palette.locator('kbd', { hasText: /^C$/ });
    await expect(kbdC).toBeVisible({ timeout: 3000 });
  });

  test('pressing C shortcut triggers new bookmark action', async ({ authedPage }) => {
    const page = authedPage;

    await page.goto('/');
    await page.waitForSelector('[data-testid="sidebar-nav"]');

    // Open palette
    await page.keyboard.press('Control+k');
    await page.waitForSelector('[data-testid="command-palette-dialog"]');
    await page.waitForSelector('[data-testid="command-palette-input"]');

    // Press C to trigger the new bookmark shortcut
    await page.keyboard.press('c');

    // Palette should close after selecting a shortcut action
    await expect(page.locator('[data-testid="command-palette-dialog"]')).not.toBeVisible({ timeout: 3000 });
  });
});