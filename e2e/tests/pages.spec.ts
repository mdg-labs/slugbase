import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { message } from "../support/catalog.ts";
import { STORAGE_STATE } from "../support/environment.ts";
import { provisionOwnMember, removeFromWorkspace, type OwnMember } from "../support/own-member.ts";
import { expect, test } from "../support/test.ts";

// The page sweep (doc 08 section 5.2): the accessibility check runs on every page a journey visits, so each page that no other
// journey reaches is visited here and scanned, in each engine. support/pages.test.ts lists the route files of packages/web and fails
// when one is neither visited by a journey nor exempt with a reason, so a new page cannot go unchecked.
//
// As the owner of the instance, who is a member of the workspace and its admin: the 403 page, the preferences, the AI settings of the
// workspace and its audit log. As a member who has no workspace (made for the run and taken out of the workspace, support/own-member.ts):
// the page that waits for an invitation. As a visitor without a session: the pages of the auth flows. The links of an email carry a
// token in the fragment of the address; the pages that need one are visited with a token made up for the run, so the page shows what
// it shows for a link that is not valid, and that state is scanned. Each such page redeems one token against the limit of the
// stack (doc 08 section 5.1, redeeming tokens). The password typed into a form is made up for the run and never printed. Every text is
// read from the catalogs of packages/web.

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

const NO_SESSION = { cookies: [], origins: [] };

function h1(page: Page, key: string): Locator {
  return page.getByRole("heading", { level: 1, name: en(key), exact: true });
}

/** The page has stopped loading: no skeleton of a wait is left on it. */
async function expectLoaded(page: Page): Promise<void> {
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
}

/** A token that no server has issued, as long as a real one, for the fragment of a link. */
function madeUpToken(): string {
  return randomBytes(32).toString("base64url");
}

test.describe("page sweep, as the owner of the instance", () => {
  test.beforeEach(async ({ account }) => {
    await account.set({ locale: "en" });
  });

  test("scans the 403 page", async ({ page, app }) => {
    await app.visit("/403", h1(page, "errorPage.forbidden.title"));
  });

  test("scans the preferences of the account", async ({ page, app }) => {
    await app.visit("/settings/account/preferences", h1(page, "settings.preferences.title"));
    await expectLoaded(page);
    await app.scan();
  });

  test("scans the AI settings of the workspace", async ({ page, app }) => {
    await app.visit("/settings/workspace/ai", h1(page, "settings.workspace.ai.title"));
    await expectLoaded(page);
    await app.scan();
  });

  test("scans the audit log of the workspace", async ({ page, app }) => {
    await app.visit("/settings/workspace/audit", h1(page, "audit.title"));
    await expectLoaded(page);
    await app.scan();
  });
});

test.describe("page sweep, as a member who has no workspace", () => {
  const run = randomBytes(4).toString("hex");
  const statePath = join(dirname(STORAGE_STATE), `no-workspace-${run}.json`);
  let member: OwnMember | undefined;

  test.use({ storageState: statePath });

  test.beforeAll(async ({ playwright }) => {
    member = await provisionOwnMember(playwright, `nowork-${run}`, statePath);
    await removeFromWorkspace(playwright, member);
  });

  test.afterAll(() => {
    rmSync(statePath, { force: true });
  });

  test("scans the page that waits for an invitation", async ({ page, app }) => {
    await app.visit("/no-workspace", h1(page, "noWorkspace.waiting.title"));
    await expect(page.getByText(en("noWorkspace.signedInAs", { email: member?.email ?? "" }), { exact: true })).toBeVisible();
    await app.scan();
  });
});

test.describe("page sweep, as a visitor without a session", () => {
  test.use({ storageState: NO_SESSION });

  test("scans the page that asks for a link to choose a new password", async ({ page, app }) => {
    await app.visit("/forgot-password", h1(page, "forgotPassword.title"));
    await expect(page.getByLabel(en("forgotPassword.email.label"), { exact: true })).toBeVisible();
    await app.scan();
  });

  test("scans the registration page of an instance that has closed it", async ({ page, app }) => {
    await app.visit("/register", h1(page, "register.closed.title"));
    await app.scan();
  });

  test("scans the page of a reset link, with its form and with the answer to a token that is not valid", async ({ page, app }) => {
    await app.visit(`/reset-password#token=${madeUpToken()}`, h1(page, "resetPassword.title"));
    await page.getByLabel(en("newPassword.label"), { exact: true }).fill(randomBytes(24).toString("base64url"));
    await app.scan();
    await page.getByRole("button", { name: en("resetPassword.submit"), exact: true }).click();
    await expect(page.getByText(en("resetPassword.expired.title"), { exact: true })).toBeVisible();
    await app.scan();
  });

  test("scans the page of a verification link, with its form and with the answer to a token that is not valid", async ({ page, app }) => {
    await app.visit(`/verify-email#token=${madeUpToken()}`, h1(page, "verifyEmail.title"));
    await page.getByLabel(en("newPassword.label"), { exact: true }).fill(randomBytes(24).toString("base64url"));
    await app.scan();
    await page.getByRole("button", { name: en("verifyEmail.submit"), exact: true }).click();
    await expect(page.getByText(en("verifyEmail.expired.title"), { exact: true })).toBeVisible();
    await app.scan();
  });

  test("scans the page of a link that confirms an email change, for a token that is not valid", async ({ page, app }) => {
    await app.visit(`/email-change/confirm#token=${madeUpToken()}`, page.getByText(en("emailChange.expired.title"), { exact: true }));
    await expect(h1(page, "emailChange.confirm.title")).toBeVisible();
  });

  test("scans the page of a link that cancels an email change, for a token that is not valid", async ({ page, app }) => {
    await app.visit(`/email-change/cancel#token=${madeUpToken()}`, page.getByText(en("emailChange.expired.title"), { exact: true }));
    await expect(h1(page, "emailChange.cancel.title")).toBeVisible();
  });
});
