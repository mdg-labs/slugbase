import { test, expect } from "../../fixtures/auth.js";
import { e2eResourceSuffix } from "../../helpers/e2e-resource-id.js";
import { loginAsWorker } from "../../helpers/worker-login.js";

const IMPORT_JSON = [
  {
    title: "E2E Import Bookmark A",
    url: "https://example.com/e2e-import-a",
  },
  {
    title: "E2E Import Bookmark B",
    url: "https://example.com/e2e-import-b",
  },
];

test.describe("Bookmark import from list page", () => {
  test("imports JSON from toolbar when workspace has bookmarks", async ({
    page,
  }, testInfo) => {
    const suffix = e2eResourceSuffix(testInfo);
    const seedTitle = `E2E Import Seed ${suffix}`;

    await loginAsWorker(page, testInfo.workerIndex);

    // Mark onboarding done so overlay does not block the bookmarks page
    await page.evaluate(() => {
      window.localStorage.setItem("sb_onboarding_done", "true");
    });

    await page.goto("/bookmarks");
    await page.waitForSelector('[data-testid="bookmark-list-page"]');

    // Seed one bookmark so the populated toolbar import button is shown
    await page.click('button[aria-label="New bookmark"]');
    await page.waitForSelector('[data-testid="bookmark-modal"]');
    await page.fill(
      "input[name=url]",
      `https://example.com/e2e-import-seed-${suffix}`,
    );
    await page.fill("input[name=title]", seedTitle);
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="bookmark-modal"]', { state: "hidden" });
    await expect(page.getByText(seedTitle, { exact: true })).toBeVisible();

    // Open import dialog from toolbar
    await page.click('[data-testid="bookmark-import-action"]');
    await page.waitForSelector('[data-testid="import-dialog"]');

    const fileInput = page.locator('[data-testid="import-dialog-file-input"]');
    await fileInput.setInputFiles({
      name: `e2e-import-${suffix}.json`,
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(IMPORT_JSON)),
    });

    await expect(page.locator('[data-testid="import-dialog-drop-zone"]')).toContainText(
      `e2e-import-${suffix}.json`,
    );

    await page.click('[data-testid="import-dialog-submit"]');

    await expect(page.locator('[data-testid="import-dialog"]')).not.toBeVisible({
      timeout: 10000,
    });

    await expect(page.getByText("E2E Import Bookmark A", { exact: true })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText("E2E Import Bookmark B", { exact: true })).toBeVisible();
  });
});
