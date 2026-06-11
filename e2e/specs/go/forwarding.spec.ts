import { type Page } from "@playwright/test";
import { test, expect } from "../../fixtures/auth.js";

/**
 * Resolve the API base URL from the test page context.
 */
function resolveApiUrl(page: Page): string {
  const header = page.context().request.defaultHeaders()?.["X-E2E-Base-URL-API"];
  if (header) return header;

  const origin = new URL(page.url()).origin;
  const project = (page.context() as Record<string, unknown>)["_project"] as
    | Record<string, unknown>
    | undefined;
  if (project?.name === "hosted") {
    return origin.replace(/:4002$/, ":4001");
  }
  return origin;
}

test.describe("Slug forwarding", () => {
  test("bookmark with forwarding slug navigates /go/:slug to external redirect", async ({
    authedPage: page,
  }) => {
    const apiUrl = resolveApiUrl(page);
    const slug = `e2e-fwd-${Date.now()}`;
    const targetUrl = "https://example.com/e2e-forwarding-test";

    // Create a bookmark with the forwarding slug via the API directly
    const createRes = await page.request.post(`${apiUrl}/api/v1/bookmarks`, {
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
    expect(page.url()).toMatch(/^https:\/\/example\.com\//);
  });
});