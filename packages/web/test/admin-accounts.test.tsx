import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { stubAdminServer, type AdminAnswer } from "./admin-server.ts";
import { ACCOUNT_BODY, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// /admin/accounts (doc 03 section 12): the accounts with their state, the search, and every recovery and administration action. The
// failure scenarios are an admin without a second factor asking for or acting on anything, a failed list shown as an empty one, an
// action sent before its confirmation or without the fresh re-authentication the server asks for, a reset link shown although mail
// carried it, the last admin or a blocked deletion shown as done, and an admin who demoted themselves left on a page the server refuses.

type InstanceAccount = ComponentTypes["schemas"]["InstanceAccount"];

const SLOW_TEST_TIMEOUT_MS = 30_000;
const LIST_PATH = "/api/v1/instance/accounts";
const REAUTH_PATH = "/api/v1/me/reauth";

function account(overrides: Partial<InstanceAccount>): InstanceAccount {
  return {
    id: "0192f3a0-aaaa-7000-8000-000000000010",
    displayName: "Grace Hopper",
    email: "grace@example.org",
    emailVerified: true,
    mfaEnabled: false,
    isInstanceAdmin: false,
    disabled: false,
    lastSignInAt: "2026-05-04T10:30:00Z",
    workspaceCount: 3,
    ...overrides,
  };
}

const ME = account({ id: ACCOUNT_BODY.id, displayName: "Ada Lovelace", email: "ada@example.org", mfaEnabled: true, isInstanceAdmin: true, workspaceCount: 1 });
const GRACE = account({});
const HEDY = account({
  id: "0192f3a0-aaaa-7000-8000-000000000011",
  displayName: "Hedy Lamarr",
  email: "hedy@example.org",
  emailVerified: false,
  lastSignInAt: null,
  workspaceCount: 0,
});
const KATHERINE = account({
  id: "0192f3a0-aaaa-7000-8000-000000000012",
  displayName: "Katherine Johnson",
  email: "katherine@example.org",
  mfaEnabled: true,
  isInstanceAdmin: true,
  disabled: true,
});

const dateTime = (value: string): string => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const SIGNED_IN = dateTime("2026-05-04T10:30:00Z");

const list = (...items: InstanceAccount[]): AdminAnswer => () => json({ items });
const withList = (...items: InstanceAccount[]) => ({ [`GET ${LIST_PATH}`]: list(...items) });
const pathOf = (target: InstanceAccount, suffix = ""): string => `${LIST_PATH}/${target.id}${suffix}`;

function validation(field: string, code: string): Response {
  return json({ type: "t", title: "t", status: 422, code: "validation_failed", detail: "d", requestId: "req-422", errors: [{ path: field, code }] }, { status: 422, contentType: "application/problem+json" });
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function open(): Promise<void> {
  window.history.replaceState(null, "", "/admin/accounts");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function rowOf(name: string): Promise<HTMLElement> {
  const cell = await screen.findByText(name);
  return cell.closest("tr") as HTMLElement;
}

async function menuOf(name: string): Promise<string[]> {
  const row = await rowOf(name);
  await press(within(row).getByRole("button", { name: `Actions for ${name}` }));
  return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
}

async function chooseAction(name: string, action: string): Promise<void> {
  const row = await rowOf(name);
  await press(within(row).getByRole("button", { name: `Actions for ${name}` }));
  await press(await screen.findByRole("menuitem", { name: action }));
}

async function typeInto(field: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(field, { target: { value } });
    await Promise.resolve();
  });
}

describe("the accounts table", () => {
  it("lists name, email, verified, two-factor, instance admin, last sign-in, workspaces and status", async () => {
    stubAdminServer({ routes: withList(ME, GRACE, HEDY, KATHERINE) });
    await open();

    const table = await screen.findByRole("table", { name: "Accounts" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Name",
      "Email",
      "Verified",
      "Two-factor",
      "Instance admin",
      "Last sign-in",
      "Workspaces",
      "Status",
      "Actions",
    ]);
    const grace = within(await rowOf("Grace Hopper")).getAllByRole("cell").map((cell) => cell.textContent);
    expect(grace).toEqual(["Grace Hopper", "grace@example.org", "Verified", "Off", "No", SIGNED_IN, "3", "Active", ""]);
    const hedy = within(await rowOf("Hedy Lamarr")).getAllByRole("cell").map((cell) => cell.textContent);
    expect(hedy).toEqual(["Hedy Lamarr", "hedy@example.org", "Not verified", "Off", "No", "Never", "0", "Active", ""]);
    const katherine = within(await rowOf("Katherine Johnson")).getAllByRole("cell").map((cell) => cell.textContent);
    expect(katherine.slice(2, 8)).toEqual(["Verified", "On", "Yes", SIGNED_IN, "3", "Disabled"]);
    expect(within(await rowOf("Ada Lovelace")).getByText("You")).toBeTruthy();
    const results = await axe(document.body, { rules: { region: { enabled: false } } });
    expect(results.violations.map(({ id }) => id)).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a loading state while the list is on its way", async () => {
    stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: () => new Promise<Response>(() => undefined) } });
    await open();

    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("There are no accounts")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a failed list as an error with a retry, never as an empty list", async () => {
    const server = stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: [() => problem(429, "rate_limited", "req-429"), list(GRACE)] } });
    await open();

    expect(await screen.findByText("The accounts could not be loaded")).toBeTruthy();
    expect(screen.queryByText("There are no accounts")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    await press(screen.getByRole("button", { name: "Try again" }));
    expect(await rowOf("Grace Hopper")).toBeTruthy();
    expect(server.received("GET", LIST_PATH)).toHaveLength(2);
  }, SLOW_TEST_TIMEOUT_MS);

  it("says so when there are no accounts", async () => {
    stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list() } });
    await open();

    expect(await screen.findByText("There are no accounts")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("narrows the list by name or email, and says when nothing matches, with a way back", async () => {
    stubAdminServer({ routes: withList(ME, GRACE, HEDY) });
    await open();
    await rowOf("Grace Hopper");

    const search = screen.getByRole("searchbox", { name: "Search accounts" });
    await typeInto(search, "HEDY@");
    expect(screen.queryByText("Grace Hopper")).toBeNull();
    expect(await rowOf("Hedy Lamarr")).toBeTruthy();
    await typeInto(search, "lovelace");
    expect(screen.queryByText("Hedy Lamarr")).toBeNull();
    expect(await rowOf("Ada Lovelace")).toBeTruthy();

    await typeInto(search, "zzz");
    expect(await screen.findByText("No account matches")).toBeTruthy();
    expect(screen.getByText("No account has a name or email containing “zzz”.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    await press(screen.getByRole("button", { name: "Clear search" }));
    expect(await rowOf("Grace Hopper")).toBeTruthy();
    expect(screen.queryByText("No account matches")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("asks for nothing and offers no action to an admin without a second factor", async () => {
    const server = stubAdminServer({ mfaEnabled: false, routes: withList(GRACE) });
    await open();

    expect(await screen.findByText("Accounts are not available yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(server.instanceCalls()).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the row actions", () => {
  it("offer what fits the account: verification for an unverified address, enabling for a disabled account, demoting for an admin", async () => {
    stubAdminServer({ routes: withList(ME, GRACE, HEDY, KATHERINE) });
    await open();

    expect(await menuOf("Hedy Lamarr")).toEqual([
      "Resend verification email",
      "Mark as verified",
      "Send reset link",
      "Disable account",
      "Make instance admin",
      "Delete account",
    ]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("offers a reset of the second factor only where one is on, and a promotion or demotion by the flag", async () => {
    stubAdminServer({ routes: withList(ME, GRACE, KATHERINE) });
    await open();

    expect(await menuOf("Katherine Johnson")).toEqual(["Send reset link", "Reset two-factor authentication", "Enable account", "Remove instance admin", "Delete account"]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("offers the admin's own row neither the reset of the second factor nor the deletion", async () => {
    stubAdminServer({ routes: withList(ME, GRACE) });
    await open();

    expect(await menuOf("Ada Lovelace")).toEqual(["Send reset link", "Disable account", "Remove instance admin"]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("resends the verification email and says so", async () => {
    const server = stubAdminServer({ routes: { ...withList(ME, HEDY), [`POST ${pathOf(HEDY, "/verification-email")}`]: () => new Response(null, { status: 202 }) } });
    await open();

    await chooseAction("Hedy Lamarr", "Resend verification email");

    expect((await screen.findAllByText("A new verification email was queued for hedy@example.org.")).length).toBeGreaterThan(0);
    expect(server.received("POST", pathOf(HEDY, "/verification-email"))).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains that no mail is configured instead of reporting the verification email as sent", async () => {
    stubAdminServer({ routes: { ...withList(ME, HEDY), [`POST ${pathOf(HEDY, "/verification-email")}`]: () => problem(503, "mail_unavailable", "req-503") } });
    await open();

    await chooseAction("Hedy Lamarr", "Resend verification email");

    expect((await screen.findAllByText("This server has no mail configured, so no email can be sent.")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/was queued/)).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("marking an address verified", () => {
  it("asks first, saying what it takes away, and sends nothing when cancelled", async () => {
    const server = stubAdminServer({ routes: withList(ME, HEDY) });
    await open();

    await chooseAction("Hedy Lamarr", "Mark as verified");
    const confirm = await screen.findByRole("alertdialog", { name: "Mark hedy@example.org as verified?" });
    expect(confirm.textContent).toContain("removes the account's password, sessions, two-factor authentication, API tokens and linked sign-ins");
    await press(within(confirm).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(server.received("PATCH", pathOf(HEDY))).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("tells the admin's own row that nothing is taken away, and does not offer the confirm as destructive", async () => {
    const OWN_UNVERIFIED = { ...ME, emailVerified: false };
    const server = stubAdminServer({
      routes: { ...withList(OWN_UNVERIFIED, GRACE), [`PATCH ${pathOf(OWN_UNVERIFIED)}`]: () => json({ ...OWN_UNVERIFIED, emailVerified: true }) },
    });
    await open();

    await chooseAction("Ada Lovelace", "Mark as verified");
    const confirm = await screen.findByRole("alertdialog", { name: "Mark ada@example.org as verified?" });
    expect(confirm.textContent).toContain("your password, sessions and two-factor authentication stay as they are");
    expect(confirm.textContent).not.toContain("removes");
    await press(within(confirm).getByRole("button", { name: "Mark as verified" }));

    expect((await screen.findAllByText("ada@example.org is marked as verified.")).length).toBeGreaterThan(0);
    expect(server.received("PATCH", pathOf(OWN_UNVERIFIED)).map(({ body }) => body)).toEqual([{ emailVerified: true }]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("sends emailVerified once confirmed, after the re-authentication, and reads the list again", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: [list(ME, HEDY), list(ME, { ...HEDY, emailVerified: true })],
        [`PATCH ${pathOf(HEDY)}`]: [() => problem(401, "reauth_required", "req-reauth"), () => json({ ...HEDY, emailVerified: true })],
        [`POST ${REAUTH_PATH}`]: () => new Response(null, { status: 204 }),
      },
    });
    await open();

    await chooseAction("Hedy Lamarr", "Mark as verified");
    const confirm = await screen.findByRole("alertdialog", { name: "Mark hedy@example.org as verified?" });
    await press(within(confirm).getByRole("button", { name: "Mark as verified" }));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(screen.queryByText("hedy@example.org is marked as verified.")).toBeNull();
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await press(within(prompt).getByRole("button", { name: "Confirm" }));

    expect((await screen.findAllByText("hedy@example.org is marked as verified.")).length).toBeGreaterThan(0);
    expect(server.received("PATCH", pathOf(HEDY)).map(({ body }) => body)).toEqual([{ emailVerified: true }, { emailVerified: true }]);
    await waitFor(() => {
      expect(within(screen.getByRole("table")).queryAllByText("Not verified")).toHaveLength(0);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the dialog and says nothing was changed when the re-authentication prompt is closed", async () => {
    const server = stubAdminServer({ routes: { ...withList(ME, HEDY), [`PATCH ${pathOf(HEDY)}`]: () => problem(401, "reauth_required", "req-reauth") } });
    await open();

    await chooseAction("Hedy Lamarr", "Mark as verified");
    const confirm = await screen.findByRole("alertdialog", { name: "Mark hedy@example.org as verified?" });
    await press(within(confirm).getByRole("button", { name: "Mark as verified" }));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await press(within(prompt).getByRole("button", { name: "Cancel" }));

    expect(await within(confirm).findByText("Confirm it is you to do this. Nothing was changed.")).toBeTruthy();
    expect(screen.queryByText("hedy@example.org is marked as verified.")).toBeNull();
    expect(server.received("PATCH", pathOf(HEDY))).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the password-reset link", () => {
  it("says it was mailed and shows no link where mail carried it", async () => {
    const server = stubAdminServer({
      routes: { ...withList(ME, GRACE), [`POST ${pathOf(GRACE, "/password-reset-link")}`]: () => json({ delivery: "mail", link: null }) },
    });
    await open();

    await chooseAction("Grace Hopper", "Send reset link");

    expect((await screen.findAllByText("A password-reset link was mailed to grace@example.org.")).length).toBeGreaterThan(0);
    expect(server.received("POST", pathOf(GRACE, "/password-reset-link"))).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Reset link for Grace Hopper" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Password-reset link" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the link without claiming the server cannot send email, where mail is configured but the account has no password", async () => {
    const server = stubAdminServer({
      mail: true,
      routes: {
        ...withList(ME, GRACE),
        [`POST ${pathOf(GRACE, "/password-reset-link")}`]: () => json({ delivery: "link", link: "http://localhost:3000/reset-password#token=abc" }),
      },
    });
    await open();

    await chooseAction("Grace Hopper", "Send reset link");

    const dialog = await screen.findByRole("dialog", { name: "Reset link for Grace Hopper" });
    expect(within(dialog).getByText("No email was sent for this link, so it is shown here instead.")).toBeTruthy();
    expect(dialog.textContent).not.toContain("cannot send email");
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Password-reset link" }).value).toBe("http://localhost:3000/reset-password#token=abc");
    expect(server.received("POST", pathOf(GRACE, "/password-reset-link"))).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the link once, with a copy button, where the API returned one", async () => {
    stubAdminServer({
      routes: {
        ...withList(ME, GRACE),
        [`POST ${pathOf(GRACE, "/password-reset-link")}`]: () => json({ delivery: "link", link: "http://localhost:3000/reset-password#token=abc" }),
      },
    });
    await open();

    await chooseAction("Grace Hopper", "Send reset link");

    const dialog = await screen.findByRole("dialog", { name: "Reset link for Grace Hopper" });
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Password-reset link" }).value).toBe("http://localhost:3000/reset-password#token=abc");
    expect(within(dialog).getByRole("button", { name: "Copy the reset link" })).toBeTruthy();
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled).toBe(true);
    await press(within(dialog).getByRole("checkbox", { name: "I have sent or saved this link" }));
    await press(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Reset link for Grace Hopper" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it.each([
    ["is disabled", "account_disabled", "This account is disabled. Enable it first."],
    ["has an unverified address", "email_unverified", "The address of this account is not verified. Mark it as verified or resend the verification email first."],
    ["has no password", "no_password", "This account signs in through a provider only, so it has no password to reset."],
  ])("explains that the account %s and shows no link", async (_name, code, message) => {
    stubAdminServer({ routes: { ...withList(ME, GRACE), [`POST ${pathOf(GRACE, "/password-reset-link")}`]: () => validation("id", code) } });
    await open();

    await chooseAction("Grace Hopper", "Send reset link");

    expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog", { name: "Reset link for Grace Hopper" })).toBeNull();
    expect(screen.queryByText(/was mailed/)).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("resetting two-factor authentication", () => {
  it("asks first and sends the reset once confirmed", async () => {
    const server = stubAdminServer({
      routes: { ...withList(ME, KATHERINE), [`POST ${pathOf(KATHERINE, "/mfa-reset")}`]: () => new Response(null, { status: 204 }) },
    });
    await open();

    await chooseAction("Katherine Johnson", "Reset two-factor authentication");
    const confirm = await screen.findByRole("alertdialog", { name: "Reset the two-factor authentication of Katherine Johnson?" });
    expect(server.received("POST", pathOf(KATHERINE, "/mfa-reset"))).toHaveLength(0);
    await press(within(confirm).getByRole("button", { name: "Reset two-factor authentication" }));

    expect((await screen.findAllByText("Two-factor authentication was reset for Katherine Johnson.")).length).toBeGreaterThan(0);
    expect(server.received("POST", pathOf(KATHERINE, "/mfa-reset"))).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains a disabled account in the dialog and does not report the reset", async () => {
    stubAdminServer({ routes: { ...withList(ME, KATHERINE), [`POST ${pathOf(KATHERINE, "/mfa-reset")}`]: () => validation("id", "account_disabled") } });
    await open();

    await chooseAction("Katherine Johnson", "Reset two-factor authentication");
    const confirm = await screen.findByRole("alertdialog", { name: "Reset the two-factor authentication of Katherine Johnson?" });
    await press(within(confirm).getByRole("button", { name: "Reset two-factor authentication" }));

    expect(await within(confirm).findByText("This account is disabled. Enable it first.")).toBeTruthy();
    expect(screen.queryByText("Two-factor authentication was reset for Katherine Johnson.")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("disabling, enabling, promoting and demoting", () => {
  it.each([
    ["Disable account", "Grace Hopper", "Disable Grace Hopper?", GRACE, { disabled: true }, "Grace Hopper is disabled."],
    ["Enable account", "Katherine Johnson", "Enable Katherine Johnson?", KATHERINE, { disabled: false }, "Katherine Johnson is enabled."],
    ["Make instance admin", "Grace Hopper", "Make Grace Hopper an instance admin?", GRACE, { isInstanceAdmin: true }, "Grace Hopper is now an instance admin."],
    ["Remove instance admin", "Katherine Johnson", "Remove Katherine Johnson as instance admin?", KATHERINE, { isInstanceAdmin: false }, "Katherine Johnson is no longer an instance admin."],
  ])("%s on %s asks first, then sends the change", async (action, name, title, target, change, done) => {
    const server = stubAdminServer({ routes: { ...withList(ME, GRACE, KATHERINE), [`PATCH ${pathOf(target)}`]: () => json(target) } });
    await open();

    await chooseAction(name, action);
    const confirm = await screen.findByRole("alertdialog", { name: title });
    expect(server.received("PATCH", pathOf(target))).toHaveLength(0);
    await press(within(confirm).getAllByRole("button", { name: action })[0] as HTMLElement);

    expect((await screen.findAllByText(done)).length).toBeGreaterThan(0);
    expect(server.received("PATCH", pathOf(target)).map(({ body }) => body)).toEqual([change]);
  }, SLOW_TEST_TIMEOUT_MS);

  it.each([
    ["Disable account", "Disable Grace Hopper?", { disabled: true }],
    ["Remove instance admin", "Remove Grace Hopper as instance admin?", { isInstanceAdmin: false }],
  ])("explains in the dialog that %s would leave the instance without an enabled admin", async (action, title, change) => {
    const admin = account({ isInstanceAdmin: true });
    const field = "disabled" in change ? "disabled" : "isInstanceAdmin";
    const server = stubAdminServer({ routes: { ...withList(ME, admin), [`PATCH ${pathOf(admin)}`]: () => validation(field, "last_instance_admin") } });
    await open();

    await chooseAction("Grace Hopper", action);
    const confirm = await screen.findByRole("alertdialog", { name: title });
    await press(within(confirm).getAllByRole("button", { name: action })[0] as HTMLElement);

    expect(await within(confirm).findByText("This is the only enabled instance admin. Make another account an instance admin first.")).toBeTruthy();
    expect(screen.queryByText(/is no longer an instance admin|is disabled\./)).toBeNull();
    expect(server.received("PATCH", pathOf(admin))).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("says in the dialog that demoting oneself ends the admin's access, and lands on the 403 page after it", async () => {
    let demoted = false;
    const server = stubAdminServer({
      me: () => json({ account: { ...ACCOUNT_BODY, isInstanceAdmin: !demoted, mfaEnabled: true }, memberships: [], activeWorkspaceId: null }),
      routes: {
        [`GET ${LIST_PATH}`]: [list(ME, GRACE), () => problem(403, "forbidden", "req-403")],
        [`PATCH ${pathOf(ME)}`]: () => {
          demoted = true;
          return json({ ...ME, isInstanceAdmin: false });
        },
      },
    });
    await open();

    await chooseAction("Ada Lovelace", "Remove instance admin");
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Ada Lovelace as instance admin?" });
    expect(confirm.textContent).toContain("This is your own account. You lose access to the administration and are signed out right away.");
    await press(within(confirm).getByRole("button", { name: "Remove instance admin" }));

    expect(await screen.findByRole("heading", { level: 1, name: "You don't have access" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(server.received("PATCH", pathOf(ME))).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("closes the dialog and reads the list again when the account is gone", async () => {
    const server = stubAdminServer({ routes: { ...withList(ME, GRACE), [`PATCH ${pathOf(GRACE)}`]: () => problem(404, "not_found", "req-404") } });
    await open();

    await chooseAction("Grace Hopper", "Disable account");
    const confirm = await screen.findByRole("alertdialog", { name: "Disable Grace Hopper?" });
    await press(within(confirm).getAllByRole("button", { name: "Disable account" })[0] as HTMLElement);

    expect((await screen.findAllByText("This account no longer exists.")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    await waitFor(() => {
      expect(server.received("GET", LIST_PATH).length).toBeGreaterThan(1);
    });
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("deleting an account", () => {
  async function openDelete(): Promise<HTMLElement> {
    await chooseAction("Grace Hopper", "Delete account");
    return screen.findByRole("alertdialog", { name: "Delete Grace Hopper?" });
  }

  it("sends nothing until the exact address is typed, and says the deletion is irreversible", async () => {
    const server = stubAdminServer({ routes: withList(ME, GRACE) });
    await open();
    const dialog = await openDelete();

    expect(dialog.textContent).toContain("This is irreversible.");
    const submit = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Delete account" });
    expect(submit.disabled).toBe(true);
    await typeInto(within(dialog).getByRole("textbox", { name: "Type grace@example.org to confirm" }), "grace@example");
    expect(submit.disabled).toBe(true);
    await typeInto(within(dialog).getByRole("textbox", { name: "Type grace@example.org to confirm" }), "grace@example.org");
    expect(submit.disabled).toBe(false);
    expect(server.received("DELETE", pathOf(GRACE))).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("deletes it after the re-authentication, says so and takes it off the list", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: [list(ME, GRACE), list(ME)],
        [`DELETE ${pathOf(GRACE)}`]: [() => problem(401, "reauth_required", "req-reauth"), () => new Response(null, { status: 204 })],
        [`POST ${REAUTH_PATH}`]: () => new Response(null, { status: 204 }),
      },
    });
    await open();
    const dialog = await openDelete();
    await typeInto(within(dialog).getByRole("textbox", { name: "Type grace@example.org to confirm" }), "grace@example.org");
    await press(within(dialog).getByRole("button", { name: "Delete account" }));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(screen.queryByText("Grace Hopper is deleted.")).toBeNull();
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await press(within(prompt).getByRole("button", { name: "Confirm" }));

    expect((await screen.findAllByText("Grace Hopper is deleted.")).length).toBeGreaterThan(0);
    expect(server.received("DELETE", pathOf(GRACE))).toHaveLength(2);
    await waitFor(() => {
      expect(screen.queryByRole("cell", { name: "Grace Hopper" })).toBeNull();
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the dialog and says nothing was sent when the re-authentication prompt is closed", async () => {
    const server = stubAdminServer({ routes: { ...withList(ME, GRACE), [`DELETE ${pathOf(GRACE)}`]: () => problem(401, "reauth_required", "req-reauth") } });
    await open();
    const dialog = await openDelete();
    await typeInto(within(dialog).getByRole("textbox", { name: "Type grace@example.org to confirm" }), "grace@example.org");
    await press(within(dialog).getByRole("button", { name: "Delete account" }));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await press(within(prompt).getByRole("button", { name: "Cancel" }));

    expect(await within(dialog).findByText("Confirm it is you to do this. Nothing was changed.")).toBeTruthy();
    expect(screen.queryByText("Grace Hopper is deleted.")).toBeNull();
    expect(server.received("DELETE", pathOf(GRACE))).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("lists the workspaces that block the deletion, from the last_owner answer, and does not report it as done", async () => {
    stubAdminServer({
      routes: {
        ...withList(ME, GRACE),
        [`DELETE ${pathOf(GRACE)}`]: () =>
          json(
            {
              type: "t",
              title: "t",
              status: 409,
              code: "last_owner",
              detail: "d",
              requestId: "req-409",
              workspaces: [
                { id: "0192f3a0-dddd-7000-8000-000000000001", name: "Analytical Engines" },
                { id: "0192f3a0-dddd-7000-8000-000000000002", name: "Compilers" },
              ],
            },
            { status: 409, contentType: "application/problem+json" },
          ),
      },
    });
    await open();
    const dialog = await openDelete();
    await typeInto(within(dialog).getByRole("textbox", { name: "Type grace@example.org to confirm" }), "grace@example.org");
    await press(within(dialog).getByRole("button", { name: "Delete account" }));

    const blocked = await screen.findByRole("dialog", { name: "Grace Hopper cannot be deleted yet" });
    const items = within(within(blocked).getByRole("list", { name: "Workspaces without another owner" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Analytical Engines", "Compilers"]);
    expect(within(blocked).queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Grace Hopper is deleted.")).toBeNull();
    expect(within(blocked).getByRole("link", { name: "Open workspaces" }).getAttribute("href")).toBe("/admin/workspaces");
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains a refusal of the deletion guard in the dialog", async () => {
    stubAdminServer({ routes: { ...withList(ME, GRACE), [`DELETE ${pathOf(GRACE)}`]: () => problem(409, "billing_active", "req-409") } });
    await open();
    const dialog = await openDelete();
    await typeInto(within(dialog).getByRole("textbox", { name: "Type grace@example.org to confirm" }), "grace@example.org");
    await press(within(dialog).getByRole("button", { name: "Delete account" }));

    expect(await within(dialog).findByText("This account has an active paid subscription. It has to be cancelled first.")).toBeTruthy();
    expect(screen.queryByText("Grace Hopper is deleted.")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains that the last enabled instance admin cannot be deleted", async () => {
    const admin = account({ isInstanceAdmin: true });
    stubAdminServer({ routes: { ...withList(ME, admin), [`DELETE ${pathOf(admin)}`]: () => validation("id", "last_instance_admin") } });
    await open();
    const dialog = await openDelete();
    await typeInto(within(dialog).getByRole("textbox", { name: "Type grace@example.org to confirm" }), "grace@example.org");
    await press(within(dialog).getByRole("button", { name: "Delete account" }));

    expect(await within(dialog).findByText("This is the only enabled instance admin. Make another account an instance admin first.")).toBeTruthy();
    expect(screen.queryByText("Grace Hopper is deleted.")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});
