import { message } from "../support/catalog.ts";
import { expectNoCspViolations, watchCsp } from "../support/csp.ts";
import { expect, test } from "../support/test.ts";

// The page's Content Security Policy (doc 01 section 4 step 2) blocks what it does not allow, and a
// blocked inline style leaves the page without the style it asked for. A signed-in member opens the
// pages of the app, and the page must not report a violation of the policy, as an event or on the console.
// The first-run wizard has the same check in tests/first-run.setup.ts.

test("a signed-in member's pages report no Content Security Policy violation", async ({ page, app, account }) => {
  // The language of a member is the account's, which other journeys change while they run.
  await account.set({ locale: "en" });
  const watch = await watchCsp(page);

  await app.visit("/settings/account/security", page.getByRole("heading", { level: 1, name: message("en", "settings.security.title") }));
  await expect(page.getByRole("button", { name: message("en", "shell.account"), exact: true })).toBeVisible();

  expectNoCspViolations(watch, "/settings/account/security");
});
