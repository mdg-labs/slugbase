import { test, expect } from "../../fixtures/auth.js";

test.describe("Go not found", () => {
  test("unknown slug shows 404 error state", async ({ authedPage: page }) => {
    const slug = `e2e-nonexistent-${Date.now()}`;

    // Navigate to a /go/:slug that does not exist
    const response = await page.goto(`/go/${slug}`);

    // The page should return a 404 status
    expect(response?.status()).toBe(404);

    // The error page should render with 404 indicator
    await page.waitForSelector('[data-testid="go-not-found"]');
  });
});
