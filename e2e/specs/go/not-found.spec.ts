import { test, expect } from "../../fixtures/auth.js";

test.describe("Go not found", () => {
  test("unknown slug shows error state", async ({ authedPage: page }) => {
    const slug = `e2e-nonexistent-${Date.now()}`;

    // Navigate to a /go/:slug that does not exist
    const response = await page.goto(`/go/${slug}`);

    // The page should return a 404 (slug not found) or 502 (backend unreachable).
    // Both indicate the slug was not resolved successfully.
    const status = response?.status();
    expect(
      status === 404 || status === 502,
      `Expected 404 or 502, got ${String(status)}`,
    ).toBe(true);

    // The error page should render with an error indicator.
    // The app-layout error boundary renders AppErrorPage which shows
    // a numeric status code and an error title heading.
    await expect(page.locator(".error-code")).toBeVisible({ timeout: 10_000 });
  });
});
