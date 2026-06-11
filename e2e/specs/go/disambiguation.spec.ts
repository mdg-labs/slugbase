import { test, expect } from "../../fixtures/auth.js";

test.describe("Go disambiguation", () => {
  test("two bookmarks with same slug shows disambiguation page, user picks candidate", async ({
    authedPage: page,
    sessionCookie,
  }) => {
    const apiUrl = process.env.E2E_BASE_URL_API ?? process.env.E2E_BASE_URL_SELF_HOSTED ?? 'http://localhost:4001';
    const slug = `e2e-disambig-${Date.now()}`;
    const url1 = "https://example.com/e2e-disambig-1";
    const url2 = "https://example.com/e2e-disambig-2";

    // Create two bookmarks with the same slug via the API directly
    const res1 = await page.request.post(`${apiUrl}/bookmarks`, {
      headers: { Cookie: sessionCookie },
      data: {
        title: "E2E Disambig One",
        url: url1,
        slug,
        forwardingEnabled: true,
      },
    });
    expect(res1.ok()).toBeTruthy();
    const bm1 = await res1.json();

    const res2 = await page.request.post(`${apiUrl}/bookmarks`, {
      headers: { Cookie: sessionCookie },
      data: {
        title: "E2E Disambig Two",
        url: url2,
        slug,
        forwardingEnabled: true,
      },
    });
    expect(res2.ok()).toBeTruthy();
    const bm2 = await res2.json();

    // Navigate to /go/:slug — should show disambiguation page
    await page.goto(`/go/${slug}`);
    await page.waitForSelector('[data-testid="go-disambiguation-page"]');

    // Both candidates should be present
    const candidate1 = page.locator(`[data-testid="go-disambiguation-candidate-${bm1.id}"]`);
    const candidate2 = page.locator(`[data-testid="go-disambiguation-candidate-${bm2.id}"]`);

    await expect(candidate1).toBeVisible();
    await expect(candidate2).toBeVisible();

    // Click the second candidate to select it
    await candidate2.click();

    // Confirm selection
    await page.click('[data-testid="go-confirm-btn"]');

    // Should redirect to the selected bookmark URL
    await page.waitForURL(url2);
    expect(page.url()).toMatch(/^https:\/\/example\.com\//);
  });

  test("disambiguation with remember preference saves choice", async ({
    authedPage: page,
    sessionCookie,
  }) => {
    const apiUrl = process.env.E2E_BASE_URL_API ?? process.env.E2E_BASE_URL_SELF_HOSTED ?? 'http://localhost:4001';
    const slug = `e2e-remember-${Date.now()}`;
    const url1 = "https://example.com/e2e-remember-1";
    const url2 = "https://example.com/e2e-remember-2";

    // Create two bookmarks with the same slug via the API directly
    const res1 = await page.request.post(`${apiUrl}/bookmarks`, {
      headers: { Cookie: sessionCookie },
      data: {
        title: "E2E Remember One",
        url: url1,
        slug,
        forwardingEnabled: true,
      },
    });
    expect(res1.ok()).toBeTruthy();
    const bm1 = await res1.json();

    await page.request.post(`${apiUrl}/bookmarks`, {
      headers: { Cookie: sessionCookie },
      data: {
        title: "E2E Remember Two",
        url: url2,
        slug,
        forwardingEnabled: true,
      },
    });

    // Navigate to disambiguation page
    await page.goto(`/go/${slug}`);
    await page.waitForSelector('[data-testid="go-disambiguation-page"]');

    // Enable "always use this" toggle
    await page.check('[data-testid="go-remember-pref-toggle"]');

    // Select the first candidate
    await page.click(`[data-testid="go-disambiguation-candidate-${bm1.id}"]`);

    // Confirm selection
    await page.click('[data-testid="go-confirm-btn"]');

    // Should redirect to bm1's URL
    await page.waitForURL(url1);

    // Navigate to the slug again — should auto-redirect without disambiguation
    // because the preference was saved
    await page.goto(`/go/${slug}`);
    await page.waitForURL(url1);
    expect(page.url()).toMatch(/^https:\/\/example\.com\//);
  });
});
