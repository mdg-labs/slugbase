import { test, expect } from "../../fixtures/auth.js";

test.describe("Slug forwarding", () => {
  test("bookmark with forwarding slug navigates /go/:slug to external redirect", async ({
    authedPage: page,
    sessionCookie,
    csrfToken,
  }) => {
    const apiUrl = process.env.E2E_BASE_URL_API ?? process.env.E2E_BASE_URL_SELF_HOSTED ?? 'http://localhost:4001';
    const slug = `e2e-fwd-${Date.now()}`;
    const targetUrl = "https://example.com/e2e-forwarding-test";

    // Create a bookmark with the forwarding slug via the API directly
    const createRes = await page.request.post(`${apiUrl}/bookmarks`, {
      headers: { Cookie: sessionCookie, "x-csrf-token": csrfToken },
      data: {
        title: "E2E Forwarding Test",
        url: targetUrl,
        slug,
        forwardingEnabled: true,
      },
    });
    expect(createRes.ok(), `Bookmark creation failed: ${createRes.status()}`).toBeTruthy();
    const bookmark = await createRes.json();
    expect(bookmark.id).toBeTruthy();

    // Navigate to /go/:slug — should redirect to the bookmark URL
    await page.goto(`/go/${slug}`);
    await page.waitForURL(targetUrl);

    // Verify we landed on the external URL
    expect(res.status()).toBe(400);
  });

  test("rejects bookmark create with javascript: URL via API", async ({
    authedPage: page,
    sessionCookie,
    csrfToken,
  }) => {
    const apiUrl =
      process.env.E2E_BASE_URL_API ??
      process.env.E2E_BASE_URL_SELF_HOSTED ??
      "http://localhost:4001";

    const createRes = await page.request.post(`${apiUrl}/bookmarks`, {
      headers: { Cookie: sessionCookie, "x-csrf-token": csrfToken },
      data: {
        title: "Malicious bookmark",
        url: "javascript:alert(1)",
      },
    });
    expect(createRes.status()).toBe(400);
  });
});
