import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { message } from "../support/catalog.ts";
import { appOrigin } from "../support/environment.ts";
import { OWNER_NAME, WORKSPACE_NAME } from "../support/instance.ts";
import { invitationLink, waitForMail } from "../support/mailpit.ts";
import { productName } from "../support/product.ts";
import { expect, test, type App } from "../support/test.ts";
import { totpCode, totpStep } from "../support/totp.ts";

// The accounts journey of the Phase 2 definition of done (doc 12, doc 08 section 5.1, doc 02 sections 2.2,
// 2.7 and 3.4): after the first-run setup (tests/first-run.setup.ts), the owner invites an address by email,
// the invited person reads the mail and accepts as a new account, turns on a second factor, and signs in
// again with a code of the authenticator app and with a backup code, which is refused the second time.
// The mail is read from the Mailpit of the stack. Every text is read from the catalogs of packages/web.
//
// The steps share one invitee and run in order on one worker: a step that fails skips the ones after it.
// The address and the password are made up for this run; neither the password, the setup key nor the
// backup codes are printed.

const NO_SESSION = { cookies: [], origins: [] };

const invitee = {
  email: `invitee-${randomBytes(4).toString("hex")}@example.test`,
  name: "Invited Person",
  password: randomBytes(24).toString("base64url"),
};

/** What one step hands the next. */
const handed: { link?: string; setupKey?: string; backupCodes?: readonly string[] } = {};

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not handed over by the step before`);
  }
  return value;
}

function homeHeading(page: Page, name: string) {
  return page.getByRole("heading", { level: 1, name: message("en", "home.title", { name }) });
}

function signInCard(page: Page) {
  return page.getByRole("region", { name: message("en", "login.title") });
}

/** Types a code into the slots of the code field, whose label names the first slot; each digit moves on to the next. */
async function typeCode(page: Page, label: string, code: string): Promise<void> {
  await page.getByRole("textbox", { name: label, exact: true }).click();
  await page.keyboard.type(code);
}

/** Signs in with the email and the password and arrives at the second step. */
async function signInUntilSecondStep(page: Page, app: App): Promise<void> {
  await app.visit("/login", signInCard(page));
  const card = signInCard(page);
  await card.getByLabel(message("en", "login.email.label"), { exact: true }).fill(invitee.email);
  await card.getByLabel(message("en", "login.password.label"), { exact: true }).fill(invitee.password);
  await card.getByRole("button", { name: message("en", "login.submit"), exact: true }).click();
  await expect(page).toHaveURL(/\/login\/mfa/);
  await expect(page.getByRole("heading", { level: 1, name: message("en", "loginMfa.title") })).toBeVisible();
  await app.scan();
}

async function signOut(page: Page, app: App): Promise<void> {
  await page.getByRole("button", { name: message("en", "shell.account"), exact: true }).click();
  await page.getByRole("menuitem", { name: message("en", "shell.signOut"), exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(signInCard(page)).toBeVisible();
  await app.scan();
}

test.describe("accounts journey: invite, accept and sign in with a second factor", () => {
  test.describe.configure({ mode: "serial" });

  test("the owner invites an address by email", async ({ page, app, account }) => {
    // The page is the owner's, and the owner's language is the account's, which other journeys set too.
    await account.set({ locale: "en" });
    await app.visit("/settings/workspace/members", page.getByRole("heading", { level: 2, name: message("en", "settings.members.invitations.title"), exact: true }));

    await page.getByRole("button", { name: message("en", "settings.members.invitations.invite"), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: message("en", "settings.members.invite.title") });
    await expect(dialog).toBeVisible();
    // The stack has a mail relay, so the dialog does not say the invitations are created without mail.
    await expect(dialog.getByText(message("en", "settings.members.invite.noMail"))).toHaveCount(0);
    await dialog.getByLabel(message("en", "settings.members.invite.emails.label"), { exact: true }).fill(invitee.email);
    await dialog.getByLabel(message("en", "settings.members.invite.emails.label"), { exact: true }).press("Enter");
    await expect(dialog.getByRole("list", { name: message("en", "settings.members.invite.addresses") })).toContainText(invitee.email);
    await app.scan();
    await dialog.getByRole("button", { name: message("en", "settings.members.invite.submit"), exact: true }).click();

    const result = page.getByRole("dialog", { name: message("en", "settings.members.invite.result.title") });
    await expect(result.getByText(message("en", "settings.members.invite.result.summary", { invited: "1", total: "1" }))).toBeVisible();
    await expect(result.getByText(message("en", "settings.members.invite.result.sent"))).toBeVisible();
    await app.scan();
    await result.getByRole("button", { name: message("en", "settings.members.invite.result.done"), exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The invitation is pending in the list.
    const row = page.getByRole("row", { name: new RegExp(invitee.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await expect(row.getByText(message("en", "settings.members.invitations.pending"), { exact: true })).toBeVisible();
    await app.scan();

    // The mail is the one the server sent through Mailpit, to the invited address, naming the workspace.
    const mail = await waitForMail(invitee.email);
    expect(mail.subject).toContain(WORKSPACE_NAME);
    handed.link = invitationLink(mail.text, appOrigin());
  });

  test.describe("the invited person", () => {
    test.use({ storageState: NO_SESSION });

    test("accepts the invitation as a new account and turns on a second factor", async ({ page, app }) => {
      const name = await productName(page);
      const link = required(handed.link, "the invitation link");
      await app.visit(link, page.getByRole("heading", { name: message("en", "invite.title") }));

      const summary = page.getByRole("term").filter({ hasText: message("en", "invite.summary.workspace") });
      await expect(summary).toBeVisible();
      await expect(page.getByText(WORKSPACE_NAME, { exact: true })).toBeVisible();
      await expect(page.getByText(OWNER_NAME, { exact: true })).toBeVisible();
      await expect(page.getByText(message("en", "invite.signUp.description"))).toBeVisible();
      // The address of the invitation is the account's, and it cannot be changed.
      await expect(page.getByLabel(message("en", "invite.signUp.email.label"), { exact: true })).toHaveValue(invitee.email);
      await expect(page.getByLabel(message("en", "invite.signUp.email.label"), { exact: true })).not.toBeEditable();

      await page.getByLabel(message("en", "invite.signUp.name.label"), { exact: true }).fill(invitee.name);
      await page.getByLabel(message("en", "newPassword.label"), { exact: true }).fill(invitee.password);
      await app.scan();
      await page.getByRole("button", { name: message("en", "invite.signUp.submit"), exact: true }).click();

      // The account is a member of the workspace and signed in: the home page opens in the shell.
      await expect(homeHeading(page, name)).toBeVisible();
      await expect(page).toHaveURL(/\/$/);
      await app.scan();

      await app.visit("/settings/account/security", page.getByRole("heading", { level: 1, name: message("en", "settings.security.title") }));
      // Starting an enrolment needs a recent confirmation of the password (doc 04 section 4.4), which the
      // session of a new account lacks: the request answers 401 reauth_required, the prompt opens, and the
      // request is sent again once the password is accepted.
      await page.getByRole("button", { name: message("en", "settings.security.mfa.enrol.open"), exact: true }).click();
      const prompt = page.getByRole("dialog", { name: message("en", "reauth.title") });
      await expect(prompt).toBeVisible();
      await prompt.getByLabel(message("en", "reauth.password.label"), { exact: true }).fill(invitee.password);
      await app.scan();
      await prompt.getByRole("button", { name: message("en", "reauth.submit"), exact: true }).click();
      await expect(prompt).toHaveCount(0);

      const wizard = page.getByRole("heading", { name: message("en", "settings.security.mfa.enrol.scan.title") });
      await expect(wizard).toBeVisible();
      await expect(page.getByRole("img", { name: message("en", "settings.security.mfa.enrol.qr.alt") })).toBeVisible();
      const key = await page.getByRole("textbox", { name: message("en", "settings.security.mfa.enrol.key.label"), exact: true }).inputValue();
      expect(key).toMatch(/^[A-Z2-7]{32}$/);
      handed.setupKey = key;
      await app.scan();
      await page.getByRole("button", { name: message("en", "settings.security.mfa.enrol.next"), exact: true }).click();

      await expect(page.getByRole("heading", { name: message("en", "settings.security.mfa.enrol.verify.title") })).toBeVisible();
      await app.scan();
      await typeCode(page, message("en", "settings.security.mfa.code.label"), totpCode(key, totpStep(Date.now())));

      await expect(page.getByRole("heading", { name: message("en", "settings.security.mfa.codes.title") })).toBeVisible();
      const codes = await page.getByRole("list", { name: message("en", "settings.security.mfa.codes.label") }).getByRole("listitem").allTextContents();
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      handed.backupCodes = codes;
      await app.scan();
      await page.getByRole("checkbox", { name: message("en", "settings.security.mfa.codes.acknowledge") }).check();
      await page.getByRole("button", { name: message("en", "settings.security.mfa.done"), exact: true }).click();

      await expect(page.getByText(message("en", "settings.security.mfa.description.on"))).toBeVisible();
      await app.scan();
      await signOut(page, app);
    });

    test("signs in with a code of the authenticator app", async ({ page, app }) => {
      const name = await productName(page);
      const key = required(handed.setupKey, "the setup key");
      await signInUntilSecondStep(page, app);
      // The code of a time step is accepted once, and the enrolment used the step it ran in, so the code to
      // give is the next step's: the server takes a code one step ahead of its clock.
      await typeCode(page, message("en", "loginMfa.code.label"), totpCode(key, totpStep(Date.now()) + 1));

      await expect(homeHeading(page, name)).toBeVisible();
      await expect(page).toHaveURL(/\/$/);
      await app.scan();
      await signOut(page, app);
    });

    test("signs in with a backup code, and the code is refused the second time", async ({ page, app }) => {
      const name = await productName(page);
      const [backupCode] = required(handed.backupCodes, "the backup codes");
      if (backupCode === undefined) {
        throw new Error("the backup codes are empty");
      }
      const useBackup = page.getByRole("button", { name: message("en", "loginMfa.useBackup"), exact: true });
      const submit = page.getByRole("button", { name: message("en", "loginMfa.submit"), exact: true });
      const field = page.getByLabel(message("en", "loginMfa.backupCode.label"), { exact: true });

      await signInUntilSecondStep(page, app);
      await useBackup.click();
      await field.fill(backupCode);
      await app.scan();
      await submit.click();
      await expect(homeHeading(page, name)).toBeVisible();
      await app.scan();
      await signOut(page, app);

      // The same code once more: the password is right, the code is not, and the visitor stays on the second step.
      await signInUntilSecondStep(page, app);
      await useBackup.click();
      await field.fill(backupCode);
      await submit.click();
      await expect(page.getByText(message("en", "loginMfa.error.invalidCode"))).toBeVisible();
      await expect(page).toHaveURL(/\/login\/mfa/);
      await expect(homeHeading(page, name)).toHaveCount(0);
      await app.scan();

      // Going back ends the half-finished sign-in.
      await page.getByRole("button", { name: message("en", "loginMfa.back"), exact: true }).click();
      await expect(signInCard(page)).toBeVisible();
      await app.scan();
    });
  });
});
