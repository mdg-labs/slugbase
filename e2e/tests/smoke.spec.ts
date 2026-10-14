import type { Page } from "@playwright/test";
import { message, type Locale } from "../support/catalog.ts";
import { expect, test } from "../support/test.ts";

// The smoke journey of the built image (doc 08 section 5.1): the shell of the
// app opens in English, the theme toggles from the keyboard, a path that no page
// owns shows the 404 page, and the shell follows the language of the browser.
// Every text is read from the catalogs of packages/web; the product name is the
// one the server reports in /api/config.

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

function homeHeading(page: Page, locale: Locale, name: string) {
  return page.getByRole("heading", { level: 1, name: message(locale, "home.empty.title", { name }) });
}

test.describe("in English", () => {
  test("opens the shell on the home page", async ({ page, app }) => {
    const name = await productName(page);
    await app.visit("/", homeHeading(page, "en", name));

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByText(message("en", "home.empty.description"))).toBeVisible();
    await expect(page.getByRole("link", { name: message("en", "shell.home") })).toBeVisible();
    await expect(page.getByRole("link", { name: message("en", "shell.skipToContent") })).toBeAttached();
  });

  test("toggles the theme with the keyboard", async ({ page, app }) => {
    const name = await productName(page);
    await app.visit("/", homeHeading(page, "en", name));

    const root = page.locator("html");
    const toLight = page.getByRole("button", { name: message("en", "shell.switchToLight") });
    const toDark = page.getByRole("button", { name: message("en", "shell.switchToDark") });
    // The test starts from a known theme: the choice is stored in the browser, and a fresh
    // context holds none, so the system preference decides (light unless the browser says dark).
    await page.emulateMedia({ colorScheme: "light" });
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

  test("shows the 404 page for a path that no page owns", async ({ page, app }) => {
    const name = await productName(page);
    await app.visit(
      MISSING_PATH,
      page.getByRole("heading", { level: 1, name: message("en", "errorPage.notFound.title") }),
    );

    // The shell's home page must not be what the path rendered.
    await expect(homeHeading(page, "en", name)).toHaveCount(0);
    await expect(page.getByText(message("en", "errorPage.notFound.description"))).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${MISSING_PATH}$`));

    // Go home leads back to the home page, which the check covers as well.
    await page.getByRole("link", { name: message("en", "errorPage.goHome") }).click();
    await expect(homeHeading(page, "en", name)).toBeVisible();
    await app.scan();
  });
});

test.describe("in German", () => {
  test.use({ locale: "de-DE" });

  test("opens the shell in the language of the browser", async ({ page, app }) => {
    const name = await productName(page);
    await app.visit("/", homeHeading(page, "de", name));

    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.getByText(message("de", "home.empty.description"))).toBeVisible();
    await expect(page.getByRole("link", { name: message("de", "shell.home") })).toBeVisible();
    await expect(homeHeading(page, "en", name)).toHaveCount(0);
  });
});
