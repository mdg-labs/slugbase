import type { Page } from "@playwright/test";
import { message, type Locale } from "../support/catalog.ts";
import { productName } from "../support/product.ts";
import { expect, test } from "../support/test.ts";

// The smoke journeys of the built image (doc 08 section 5.1), in English and in the
// language of the browser. Every text is read from the catalogs of packages/web; the
// product name is the one the server reports in /api/config.
//
// As a member, from the session the global setup signed in (e2e/global-setup.ts): the
// home heading, the 404 page inside the shell for a path that no page owns, and the
// theme toggle of the top bar from the keyboard.
//
// As a visitor without a session: every page of the app sends them to the sign-in
// page, which names the page they asked for in `next`.

const MISSING_PATH = "/this-page-does-not-exist";

const NO_SESSION = { cookies: [], origins: [] };

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

test.describe("a visitor without a session, in English", () => {
  test.use({ storageState: NO_SESSION });

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

test.describe("a visitor without a session, in German", () => {
  test.use({ locale: "de-DE", storageState: NO_SESSION });

  test("shows the sign-in page in the language of the browser", async ({ page, app }) => {
    const name = await productName(page);
    await app.visit("/", authenticationCard(page, "de"));

    await expect(page).toHaveURL(/\/login\?next=%2F$/);
    await expectSignInPage(page, "de", name);
    await expect(authenticationCard(page, "en")).toHaveCount(0);
  });
});

function homeHeading(page: Page, locale: Locale, name: string) {
  return page.getByRole("heading", { level: 1, name: message(locale, "home.empty.title", { name }) });
}

const LANGUAGES: readonly { readonly locale: Locale; readonly browser: string; readonly title: string }[] = [
  { locale: "en", browser: "en-US", title: "in English" },
  { locale: "de", browser: "de-DE", title: "in German" },
];

for (const { locale, browser, title } of LANGUAGES) {
  test.describe(`a signed-in member, ${title}`, () => {
    test.use({ locale: browser });

    test("opens the shell on the home page", async ({ page, app }) => {
      const name = await productName(page);
      await app.visit("/", homeHeading(page, locale, name));

      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.getByText(message(locale, "home.empty.description"))).toBeVisible();
      await expect(page.getByRole("link", { name: message(locale, "shell.home") })).toBeVisible();
      await expect(page.getByRole("link", { name: message(locale, "shell.skipToContent") })).toBeAttached();
      // The member is not sent to sign in.
      await expect(authenticationCard(page, locale)).toHaveCount(0);
    });

    test("toggles the theme with the keyboard", async ({ page, app }) => {
      // The test starts from a known theme: the light choice is stored before the page loads, so
      // neither the saved signed-in state nor how an engine applies media emulation decides it.
      await page.addInitScript(() => {
        window.localStorage.setItem("slugbase-theme", "light");
      });
      const name = await productName(page);
      await app.visit("/", homeHeading(page, locale, name));

      const root = page.locator("html");
      const toLight = page.getByRole("button", { name: message(locale, "shell.switchToLight") });
      const toDark = page.getByRole("button", { name: message(locale, "shell.switchToDark") });
      await expect(root).toHaveClass(/\blight\b/);

      await toDark.focus();
      await expect(toDark).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(root).toHaveClass(/\bdark\b/);
      await expect(root).not.toHaveClass(/\blight\b/);
      await expect(toLight).toBeVisible();
      await app.scan();

      await toLight.focus();
      await page.keyboard.press("Space");
      await expect(root).toHaveClass(/\blight\b/);
      await expect(root).not.toHaveClass(/\bdark\b/);
      await expect(toDark).toBeVisible();
      await app.scan();
    });

    test("shows the 404 page inside the shell for a path that no page owns", async ({ page, app }) => {
      const name = await productName(page);
      await app.visit(MISSING_PATH, page.getByRole("heading", { level: 1, name: message(locale, "errorPage.notFound.title") }));

      // The home page must not be what the path rendered, and the shell is around the page.
      await expect(homeHeading(page, locale, name)).toHaveCount(0);
      await expect(page.getByText(message(locale, "errorPage.notFound.description"))).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${MISSING_PATH}$`));
      await expect(page.getByRole("link", { name: message(locale, "shell.home"), exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: message(locale, "shell.switchToDark") })).toBeVisible();

      // Go home leads back to the home page, which the check covers as well.
      await page.getByRole("link", { name: message(locale, "errorPage.goHome") }).click();
      await expect(homeHeading(page, locale, name)).toBeVisible();
      await app.scan();
    });
  });
}
