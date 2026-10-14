import type { Page } from "@playwright/test";
import { message, type Locale } from "../support/catalog.ts";
import { expect, test } from "../support/test.ts";

// The smoke journey of the built image (doc 08 section 5.1) as a visitor without a
// session: every page of the app sends them to the sign-in page, which names the
// page they asked for in `next`. The sign-in page and the redirect are checked in
// English and in the language of the browser. Every text is read from the catalogs
// of packages/web; the product name is the one the server reports in /api/config.
//
// The journeys of a signed-in member (the home heading, the 404 page inside the
// shell, the theme toggle of the top bar) need an account, which the e2e stack
// cannot create before first-run setup (#84) exists. They follow in #450.

const MISSING_PATH = "/this-page-does-not-exist";

async function productName(page: Page): Promise<string> {
  const response = await page.request.get("/api/config");
  expect(response.ok(), "GET /api/config").toBe(true);
  const config = (await response.json()) as { product?: { name?: unknown } };
  const name = config.product?.name;
  if (typeof name !== "string" || name === "") {
    throw new Error("GET /api/config has no product name");
  }
  return name;
}

function authenticationCard(page: Page, locale: Locale) {
  return page.getByRole("region", { name: message(locale, "login.title") });
}

/** The sign-in page and what it holds, in a language: the card, its heading, email, password, "Remember me" and the submit button. */
async function expectSignInPage(page: Page, locale: Locale, name: string): Promise<void> {
  const card = authenticationCard(page, locale);
  await expect(card).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(card.getByRole("heading", { level: 1, name: message(locale, "login.title") })).toBeVisible();
  await expect(card.getByText(message(locale, "login.description", { name }))).toBeVisible();
  await expect(card.getByLabel(message(locale, "login.email.label"), { exact: true })).toBeVisible();
  await expect(card.getByLabel(message(locale, "login.password.label"), { exact: true })).toBeVisible();
  await expect(card.getByRole("checkbox", { name: message(locale, "login.remember") })).toBeVisible();
  await expect(card.getByRole("button", { name: message(locale, "login.submit"), exact: true })).toBeVisible();
}

/** The path and the `next` value the address holds once the visit has been sent to sign in. */
function signInTarget(page: Page): { pathname: string; next: string | null } {
  const url = new URL(page.url());
  return { pathname: url.pathname, next: url.searchParams.get("next") };
}

test.describe("in English", () => {
  test("sends the home page to sign in and shows the sign-in page", async ({ page, app }) => {
    const name = await productName(page);
    await app.visit("/", authenticationCard(page, "en"));

    await expect(page).toHaveURL(/\/login\?next=%2F$/);
    await expectSignInPage(page, "en", name);
    // The shell of the app is not what the visit rendered.
    await expect(page.getByRole("link", { name: message("en", "shell.skipToContent") })).toHaveCount(0);
  });

  test("sends a path that no page owns to sign in and names the path in next", async ({ page, app }) => {
    const name = await productName(page);
    await app.visit(MISSING_PATH, authenticationCard(page, "en"));

    expect(signInTarget(page)).toEqual({ pathname: "/login", next: MISSING_PATH });
    await expectSignInPage(page, "en", name);
    // A signed-out visitor learns nothing about which paths exist.
    await expect(page.getByRole("heading", { level: 1, name: message("en", "errorPage.notFound.title") })).toHaveCount(0);
  });
});

test.describe("in German", () => {
  test.use({ locale: "de-DE" });

  test("shows the sign-in page in the language of the browser", async ({ page, app }) => {
    const name = await productName(page);
    await app.visit("/", authenticationCard(page, "de"));

    await expect(page).toHaveURL(/\/login\?next=%2F$/);
    await expectSignInPage(page, "de", name);
    await expect(authenticationCard(page, "en")).toHaveCount(0);
  });
});
