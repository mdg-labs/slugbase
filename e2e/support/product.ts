import { expect, type Page } from "@playwright/test";

/** The product name the server reports in /api/config, which the home page and the sign-in page name. */
export async function productName(page: Page): Promise<string> {
  const response = await page.request.get("/api/config");
  expect(response.ok(), "GET /api/config").toBe(true);
  const config = (await response.json()) as { product?: { name?: unknown } };
  const name = config.product?.name;
  if (typeof name !== "string" || name === "") {
    throw new Error("GET /api/config has no product name");
  }
  return name;
}
