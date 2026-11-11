import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { message } from "../support/catalog.ts";
import { appOrigin, STORAGE_STATE } from "../support/environment.ts";
import { provisionOwnMember, removeFromWorkspace, type OwnMember } from "../support/own-member.ts";
import { expect, test } from "../support/test.ts";

// The API token journey (doc 08 section 5.1, doc 03 section 11.3, doc 04 sections 4.4 and 4.6): a member creates a token on the
// tokens page, is asked to confirm it is them because the session is new, is shown the token once, uses it as a bearer credential
// against `GET /api/v1/bookmarks` (200), revokes it in the page and finds the same request refused (401). Each page and overlay it
// reaches is scanned for WCAG 2.2 AA violations (tests/axe.spec.ts, support/axe.ts). Every text is read from the catalogs of
// packages/web.
//
// The owner of the instance signed in with a password nobody keeps, and creating a token needs the account's password, so the
// journey acts as a member of its own (support/own-member.ts), made for the run in each engine and removed when it ends. The
// password and the token are never printed.

const en = (key: string, values: Readonly<Record<string, string>> = {}): string => message("en", key, values);

const NO_SESSION = { cookies: [], origins: [] };

const BOOKMARKS = "/api/v1/bookmarks";

test.describe("API token journey", () => {
  const run = randomBytes(4).toString("hex");
  const statePath = join(dirname(STORAGE_STATE), `api-tokens-${run}.json`);
  let member: OwnMember | undefined;

  test.use({ storageState: statePath });

  test.beforeAll(async ({ playwright }) => {
    member = await provisionOwnMember(playwright, `tokens-${run}`, statePath);
  });

  test.afterAll(async ({ playwright }) => {
    try {
      if (member !== undefined) {
        await removeFromWorkspace(playwright, member);
      }
    } finally {
      rmSync(statePath, { force: true });
    }
  });

  test("creates a token, shows it once, uses it as a bearer credential and revokes it", async ({ page, app, playwright }) => {
    test.setTimeout(120_000);
    if (member === undefined) {
      throw new Error("the member was not provisioned before the journey");
    }
    const { password } = member;
    const name = `Journey ${run}`;
    const heading = page.getByRole("heading", { level: 1, name: en("settings.tokens.title"), exact: true });

    /** The status the server answers a request with the token as a bearer credential. */
    const statusWith = async (token: string): Promise<number> => {
      const bearer = await playwright.request.newContext({
        baseURL: appOrigin(),
        ignoreHTTPSErrors: true,
        storageState: NO_SESSION,
        extraHTTPHeaders: { authorization: `Bearer ${token}` },
      });
      try {
        return (await bearer.get(BOOKMARKS)).status();
      } finally {
        await bearer.dispose();
      }
    };

    await test.step("lists no token on the page of a member who has made none", async () => {
      await app.visit("/settings/account/tokens", heading);
      await expect(page.getByText(en("settings.tokens.empty.title"), { exact: true })).toBeVisible();
    });

    let token = "";
    await test.step("asks for the password, creates the token and shows it once", async () => {
      await page.getByRole("button", { name: en("settings.tokens.new"), exact: true }).first().click();
      const form = page.getByRole("dialog", { name: en("settings.tokens.create.title"), exact: true });
      await expect(form).toBeVisible();
      await app.scan();
      await form.getByRole("textbox", { name: en("settings.tokens.name.label"), exact: true }).fill(name);
      await form.getByRole("button", { name: en("settings.tokens.create.submit"), exact: true }).click();

      // The session of an account that has just accepted its invitation has not confirmed the password, so the shared prompt asks.
      const confirm = page.getByRole("dialog", { name: en("reauth.title"), exact: true });
      await expect(confirm).toBeVisible();
      await confirm.getByLabel(en("reauth.password.label"), { exact: true }).fill(password);
      await confirm.getByRole("button", { name: en("reauth.submit"), exact: true }).click();

      const shown = page.getByRole("dialog", { name: en("settings.tokens.result.title"), exact: true });
      await expect(shown).toBeVisible();
      token = await shown.getByRole("textbox", { name: en("settings.tokens.result.label"), exact: true }).inputValue();
      expect(token, "the token is shown").toMatch(/^slb_/);
      await app.scan();
      // The token is not shown again: Done stays disabled until the member says they saved it.
      await expect(shown.getByRole("button", { name: en("settings.tokens.done"), exact: true })).toBeDisabled();
      await shown.getByRole("checkbox", { name: en("settings.tokens.result.acknowledge") }).check();
      await shown.getByRole("button", { name: en("settings.tokens.done"), exact: true }).click();
      await expect(shown).toBeHidden();
    });

    await test.step("lists the token by its name and its prefix, without the secret", async () => {
      const row = page.getByRole("row").filter({ hasText: name });
      await expect(row).toBeVisible();
      await expect(row).toContainText(token.slice(0, "slb_".length + 6));
      await expect(page.getByText(token, { exact: true })).toHaveCount(0);
      await app.scan();
    });

    await test.step("answers 200 to a request with the token as a bearer credential", async () => {
      expect(await statusWith(token), `GET ${BOOKMARKS} with the token`).toBe(200);
    });

    await test.step("revokes the token in the page", async () => {
      await page.getByRole("button", { name: en("settings.tokens.revokeNamed", { name }), exact: true }).click();
      const confirm = page.getByRole("alertdialog", { name: en("settings.tokens.confirm.title", { name }), exact: true });
      await expect(confirm).toBeVisible();
      await app.scan();
      await confirm.getByRole("button", { name: en("settings.tokens.confirm.action"), exact: true }).click();
      await expect(confirm).toBeHidden();
      await expect(page.getByText(en("settings.tokens.empty.title"), { exact: true })).toBeVisible();
      await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
      // The toast that says so is not part of the page under test, and it does not go while the pointer rests on its stack.
      await page.mouse.move(0, 0);
      await expect(page.locator("[data-slot='toast-title']")).toHaveCount(0);
      await app.scan();
    });

    await test.step("answers 401 to the same request once the token is revoked", async () => {
      expect(await statusWith(token), `GET ${BOOKMARKS} with the revoked token`).toBe(401);
    });
  });
});
