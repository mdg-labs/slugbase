import type { Page } from "@playwright/test";
import { findViolations, parseAllowlist, type AllowlistEntry } from "../support/axe.ts";
import { message } from "../support/catalog.ts";
import { openPaletteWithShortcut, paletteDialog } from "../support/palette.ts";
import { productName } from "../support/product.ts";
import { expect, test } from "../support/test.ts";

// The accessibility check of the journeys (doc 08 section 5.2) must fail on a
// violation and spare only what the reviewed allowlist names. These cases run on
// markup of their own, so they say nothing about the app; they keep the check
// from passing for the wrong reason.

const IMAGE_WITHOUT_ALTERNATIVE = '<main><h1>Title</h1><img id="logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main>';

test.describe("the axe check", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(`<!doctype html><html lang="en"><head><title>Page</title></head><body>${IMAGE_WITHOUT_ALTERNATIVE}</body></html>`);
  });

  test("fails on a violation that the allowlist does not name", async ({ page }) => {
    const violations = await findViolations(page, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("image-alt");
    expect(violations[0]).toContain("#logo");
  });

  test("still fails when the allowlist names another rule or another element", async ({ page }) => {
    const unrelated: AllowlistEntry[] = [
      { rule: "color-contrast", target: "#logo", reason: "a different rule" },
      { rule: "image-alt", target: "#other", reason: "a different element" },
    ];
    expect(await findViolations(page, unrelated)).toHaveLength(1);
  });

  test("spares the element that a reviewed entry names", async ({ page }) => {
    const reviewed: AllowlistEntry[] = [{ rule: "image-alt", target: "#logo", reason: "a test of the allowlist" }];
    expect(await findViolations(page, reviewed)).toEqual([]);
  });

  test("passes a page without violations", async ({ page }) => {
    await page.setContent('<!doctype html><html lang="en"><head><title>Page</title></head><body><main><h1>Title</h1></main></body></html>');
    expect(await findViolations(page, [])).toEqual([]);
  });
});

// The theme of a visitor without a session is the stored choice (the key of ThemeProvider in packages/ui),
// set before the page loads; the system preference would leave the result to how each engine applies media
// emulation. The theme of a signed-in member is the account's, set through the API before the page loads:
// once the app has the account, its theme overrides the stored choice.
for (const scheme of ["light", "dark"] as const) {
  const stored = async ({ page }: { page: Page }): Promise<void> => {
    await page.addInitScript((theme) => {
      window.localStorage.setItem("slugbase-theme", theme);
    }, scheme);
  };
  const themed = new RegExp(`\\b${scheme}\\b`);

  test.describe(`the sign-in page of a visitor without a session in the ${scheme} theme`, () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    test.beforeEach(stored);

    test("has no accessibility violations", async ({ page, app }) => {
      await app.visit("/login", page.getByRole("region", { name: message("en", "login.title") }));
      await expect(page.locator("html")).toHaveClass(themed);
    });
  });

  test.describe(`the shell of a signed-in member in the ${scheme} theme`, () => {
    test.beforeEach(async ({ account }) => {
      await account.set({ theme: scheme, locale: "en" });
    });

    test("has no accessibility violations", async ({ page, app }) => {
      const name = await productName(page);
      await app.visit("/", page.getByRole("heading", { level: 1, name: message("en", "home.empty.title", { name }) }));
      await expect(page.locator("html")).toHaveClass(themed);
      // The toggle offers the other theme, so the shell that was scanned is the one in this theme.
      await expect(page.getByRole("button", { name: message("en", scheme === "light" ? "shell.switchToDark" : "shell.switchToLight") })).toBeVisible();
      // The command palette is the shell's overlay: it is scanned open in this theme too, in the journey that holds the account's
      // preferences already, so that the queue for them does not grow.
      await openPaletteWithShortcut(page);
      await expect(paletteDialog(page)).toBeVisible();
      await app.scan();
    });
  });
}

test.describe("the allowlist file", () => {
  test("is a list of entries that each carry a rule, a target and a reason", () => {
    expect(parseAllowlist([])).toEqual([]);
    expect(parseAllowlist([{ rule: "image-alt", target: "#logo", reason: "reviewed" }])).toHaveLength(1);
    expect(() => parseAllowlist({})).toThrow("JSON array");
    expect(() => parseAllowlist([{ rule: "image-alt", target: "#logo" }])).toThrow("reason");
    expect(() => parseAllowlist([{ rule: "image-alt", target: "#logo", reason: " " }])).toThrow("reason");
    expect(() => parseAllowlist([{ rule: "", target: "#logo", reason: "x" }])).toThrow("rule");
    expect(() => parseAllowlist([{ rule: "image-alt", target: "#logo", reason: "x", other: 1 }])).toThrow("unknown keys");
  });
});
