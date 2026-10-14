import { findViolations, parseAllowlist, type AllowlistEntry } from "../support/axe.ts";
import { message } from "../support/catalog.ts";
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

// The journeys of a signed-in member (the shell in both themes, the theme toggle) need an account, which
// the e2e stack cannot create before first-run setup (#84) exists; they follow in #450.
test.describe("the sign-in page", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`has no accessibility violations in the ${scheme} theme`, async ({ page, app }) => {
      // The theme is the member's stored choice (the key of ThemeProvider in packages/ui), set before the
      // page loads; the system preference would leave the result to how each engine applies media emulation.
      await page.addInitScript((theme) => {
        window.localStorage.setItem("slugbase-theme", theme);
      }, scheme);
      await app.visit("/login", page.getByRole("region", { name: message("en", "login.title") }));
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${scheme}\\b`));
    });
  }
});

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
