import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { stubAdminServer, type AdminAnswer } from "./admin-server.ts";
import { ACCOUNT_BODY, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// /admin/workspaces (doc 03 section 12): the workspaces with their owners and member counts, creation for an owner, joining as a
// member, re-issuing the invitation of a workspace without an owner, and deletion. The failure scenarios are an admin without a
// second factor asking for or acting on anything, a failed list shown as an empty one, an action sent before its confirmation or
// without the fresh re-authentication the server asks for, a link that is shown although mail carried it, and a refusal shown as done.

type InstanceWorkspace = ComponentTypes["schemas"]["InstanceWorkspace"];
type InstanceAccount = ComponentTypes["schemas"]["InstanceAccount"];

const SLOW_TEST_TIMEOUT_MS = 30_000;
const LIST_PATH = "/api/v1/instance/workspaces";
const ACCOUNTS_PATH = "/api/v1/instance/accounts";
const REAUTH_PATH = "/api/v1/me/reauth";

const OWNED: InstanceWorkspace = {
  id: "0192f3a0-dddd-7000-8000-000000000001",
  name: "Analytical Engines",
  owners: [{ accountId: "0192f3a0-aaaa-7000-8000-000000000002", displayName: "Grace Hopper", email: "grace@example.org" }],
  memberCount: 4,
  createdAt: "2026-03-01T09:00:00Z",
};
const PENDING: InstanceWorkspace = {
  id: "0192f3a0-dddd-7000-8000-000000000002",
  name: "Waiting Room",
  owners: [],
  memberCount: 0,
  createdAt: "2026-04-02T09:00:00Z",
};

function account(overrides: Partial<InstanceAccount>): InstanceAccount {
  return {
    id: "0192f3a0-aaaa-7000-8000-000000000003",
    displayName: "Hedy Lamarr",
    email: "hedy@example.org",
    emailVerified: true,
    mfaEnabled: false,
    isInstanceAdmin: false,
    disabled: false,
    lastSignInAt: null,
    workspaceCount: 1,
    ...overrides,
  };
}

const HEDY = account({});
const DISABLED = account({ id: "0192f3a0-aaaa-7000-8000-000000000004", displayName: "Gone Gertrude", email: "gertrude@example.org", disabled: true });

const list = (...items: InstanceWorkspace[]): AdminAnswer => () => json({ items });
const accounts: AdminAnswer = () => json({ items: [HEDY, DISABLED] });

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
  window.history.replaceState(null, "", "/admin/workspaces");
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

async function chooseAction(workspace: string, action: string): Promise<void> {
  const row = await rowOf(workspace);
  await press(within(row).getByRole("button", { name: `Actions for ${workspace}` }));
  await press(await screen.findByRole("menuitem", { name: action }));
}

async function typeInto(field: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(field, { target: { value } });
    await Promise.resolve();
  });
}

async function violations(): Promise<string[]> {
  const results = await axe(document.body, { rules: { region: { enabled: false } } });
  return results.violations.map((violation) => violation.id);
}

describe("the workspaces table", () => {
  it("lists the name, owners, members and creation date of each workspace, and no content counts", async () => {
    stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list(OWNED, PENDING) } });
    await open();

    const table = await screen.findByRole("table", { name: "Workspaces" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Name", "Owners", "Members", "Created", "Actions"]);
    const row = await rowOf("Analytical Engines");
    expect(within(row).getByText("Grace Hopper")).toBeTruthy();
    expect(within(row).getByText("grace@example.org")).toBeTruthy();
    expect(within(row).getByText("4")).toBeTruthy();
    expect(within(row).getByText(new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(OWNED.createdAt)))).toBeTruthy();
    expect(await violations()).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("marks a workspace without an owner as waiting for its first owner", async () => {
    stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list(OWNED, PENDING) } });
    await open();

    const pending = await rowOf("Waiting Room");
    expect(within(pending).getByText("Waiting for its first owner")).toBeTruthy();
    expect(within(await rowOf("Analytical Engines")).queryByText("Waiting for its first owner")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a loading state while the list is on its way", async () => {
    stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: () => new Promise<Response>(() => undefined) } });
    await open();

    expect(await screen.findByRole("heading", { level: 1, name: "Workspaces" })).toBeTruthy();
    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("There are no workspaces yet")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a failed list as an error with a retry, never as an empty list", async () => {
    const server = stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: [() => problem(429, "rate_limited", "req-429"), list(OWNED)] } });
    await open();

    expect(await screen.findByText("The workspaces could not be loaded")).toBeTruthy();
    expect(screen.queryByText("There are no workspaces yet")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();

    await press(screen.getByRole("button", { name: "Try again" }));
    expect(await rowOf("Analytical Engines")).toBeTruthy();
    expect(server.received("GET", LIST_PATH)).toHaveLength(2);
  }, SLOW_TEST_TIMEOUT_MS);

  it("says so when the instance has no workspace", async () => {
    stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list() } });
    await open();

    expect(await screen.findByText("There are no workspaces yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("asks for nothing and offers no action to an admin without a second factor", async () => {
    const server = stubAdminServer({ mfaEnabled: false, routes: { [`GET ${LIST_PATH}`]: list(OWNED) } });
    await open();

    expect(await screen.findByText("Workspaces are not available yet")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create workspace" }).disabled).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();
    expect(server.instanceCalls()).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the 403 page when the list is refused because the account is no longer an admin", async () => {
    const demoted = (call: number) => {
      const body = { ...ACCOUNT_BODY, isInstanceAdmin: call === 1, mfaEnabled: true };
      return json({ account: body, memberships: [], activeWorkspaceId: null });
    };
    const server = stubAdminServer({ me: demoted, routes: { [`GET ${LIST_PATH}`]: () => problem(403, "forbidden", "req-403") } });
    await open();

    expect(await screen.findByRole("heading", { level: 1, name: "You don't have access" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(server.received("GET", LIST_PATH)).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("creating a workspace", () => {
  async function openDialog(): Promise<HTMLElement> {
    await press(await screen.findByRole("button", { name: "Create workspace" }));
    return screen.findByRole("dialog", { name: "Create a workspace" });
  }

  async function chooseAccount(dialog: HTMLElement, label: RegExp): Promise<void> {
    const input = within(dialog).getByRole("combobox", { name: "Account" });
    await act(async () => {
      fireEvent.pointerDown(input);
      fireEvent.mouseDown(input);
      fireEvent.click(input);
      await Promise.resolve();
    });
    await press(await screen.findByRole("option", { name: label }));
  }

  it("creates it for an existing account chosen from the enabled accounts", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: [list(OWNED), list(OWNED)],
        [`GET ${ACCOUNTS_PATH}`]: accounts,
        [`POST ${LIST_PATH}`]: () => json({ id: "0192f3a0-dddd-7000-8000-000000000009", name: "Lab", ownerInvitation: null }, { status: 201 }),
      },
    });
    await open();
    const dialog = await openDialog();

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "  Lab  ");
    const input = within(dialog).getByRole("combobox", { name: "Account" });
    await act(async () => {
      fireEvent.pointerDown(input);
      fireEvent.mouseDown(input);
      fireEvent.click(input);
      await Promise.resolve();
    });
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Hedy Lamarrhedy@example.org"]);
    await press(options[0] as HTMLElement);
    await press(within(dialog).getByRole("button", { name: "Create workspace" }));

    await waitFor(() => {
      expect(server.received("POST", LIST_PATH)).toHaveLength(1);
    });
    expect(server.received("POST", LIST_PATH)[0]?.body).toEqual({ name: "Lab", ownerAccountId: HEDY.id });
    expect((await screen.findAllByText("“Lab” was created.")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Create a workspace" })).toBeNull();
    });
    await waitFor(() => {
      expect(server.received("GET", LIST_PATH)).toHaveLength(2);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("asks for a name and an owner before it sends anything", async () => {
    const server = stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list(OWNED), [`GET ${ACCOUNTS_PATH}`]: accounts } });
    await open();
    const dialog = await openDialog();

    await press(within(dialog).getByRole("button", { name: "Create workspace" }));
    expect(await within(dialog).findByText("Enter a name.")).toBeTruthy();
    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Lab");
    await press(within(dialog).getByRole("button", { name: "Create workspace" }));
    expect(await within(dialog).findByText("Choose an account.")).toBeTruthy();
    expect(server.received("POST", LIST_PATH)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("invites an owner by email and says the invitation was mailed, without showing a link", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: list(OWNED),
        [`GET ${ACCOUNTS_PATH}`]: accounts,
        [`POST ${LIST_PATH}`]: () =>
          json(
            {
              id: "0192f3a0-dddd-7000-8000-000000000009",
              name: "Lab",
              ownerInvitation: { id: "0192f3a0-eeee-7000-8000-000000000001", email: "new@example.org", expiresAt: "2026-12-01T00:00:00Z", link: null },
            },
            { status: 201 },
          ),
      },
    });
    await open();
    const dialog = await openDialog();

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Lab");
    await press(within(dialog).getByRole("radio", { name: "Invite by email" }));
    await typeInto(within(dialog).getByRole("textbox", { name: "Email address" }), "new@example.org");
    await press(within(dialog).getByRole("button", { name: "Create workspace" }));

    expect((await screen.findAllByText("“Lab” was created. The owner invitation was mailed to new@example.org.")).length).toBeGreaterThan(0);
    expect(server.received("POST", LIST_PATH)[0]?.body).toEqual({ name: "Lab", ownerEmail: "new@example.org" });
    expect(screen.queryByRole("textbox", { name: "Owner invitation link" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the invitation link once when mail is not configured, and keeps Done off until it is acknowledged", async () => {
    stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: list(OWNED),
        [`GET ${ACCOUNTS_PATH}`]: accounts,
        [`POST ${LIST_PATH}`]: () =>
          json(
            {
              id: "0192f3a0-dddd-7000-8000-000000000009",
              name: "Lab",
              ownerInvitation: { id: "0192f3a0-eeee-7000-8000-000000000001", email: "new@example.org", expiresAt: "2026-12-01T00:00:00Z", link: "http://localhost:3000/invite/abc" },
            },
            { status: 201 },
          ),
      },
    });
    await open();
    const dialog = await openDialog();

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Lab");
    await press(within(dialog).getByRole("radio", { name: "Invite by email" }));
    await typeInto(within(dialog).getByRole("textbox", { name: "Email address" }), "new@example.org");
    await press(within(dialog).getByRole("button", { name: "Create workspace" }));

    const link = await within(dialog).findByRole<HTMLInputElement>("textbox", { name: "Owner invitation link" });
    expect(link.value).toBe("http://localhost:3000/invite/abc");
    expect(within(dialog).getByRole("button", { name: "Copy the invitation link" })).toBeTruthy();
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled).toBe(true);
    await press(within(dialog).getByRole("checkbox", { name: "I have sent or saved this link" }));
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled).toBe(false);
    await press(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Create a workspace" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it.each([
    ["a name the server refuses", { path: "name", code: "too_big" }, "Use a name of 1 to 64 characters."],
    ["an address the server refuses", { path: "ownerEmail", code: "invalid_string" }, "Enter a valid email address."],
  ])("keeps the dialog and explains %s", async (_name, field, message) => {
    stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: list(OWNED),
        [`GET ${ACCOUNTS_PATH}`]: accounts,
        [`POST ${LIST_PATH}`]: () =>
          json({ type: "t", title: "t", status: 422, code: "validation_failed", detail: "d", requestId: "req-422", errors: [field] }, { status: 422, contentType: "application/problem+json" }),
      },
    });
    await open();
    const dialog = await openDialog();
    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Lab");
    await press(within(dialog).getByRole("radio", { name: "Invite by email" }));
    await typeInto(within(dialog).getByRole("textbox", { name: "Email address" }), "new@example.org");
    await press(within(dialog).getByRole("button", { name: "Create workspace" }));

    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(screen.queryByText(/was created/)).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains an owner account that is gone and reads the accounts again", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: list(OWNED),
        [`GET ${ACCOUNTS_PATH}`]: accounts,
        [`POST ${LIST_PATH}`]: () =>
          json({ type: "t", title: "t", status: 422, code: "validation_failed", detail: "d", requestId: "req-422", errors: [{ path: "ownerAccountId", code: "unknown_account" }] }, { status: 422, contentType: "application/problem+json" }),
      },
    });
    await open();
    const dialog = await openDialog();
    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Lab");
    await chooseAccount(dialog, /Hedy Lamarr/);
    await press(within(dialog).getByRole("button", { name: "Create workspace" }));

    expect(await within(dialog).findByText("This account no longer exists or is disabled. Choose another one.")).toBeTruthy();
    await waitFor(() => {
      expect(server.received("GET", ACCOUNTS_PATH).length).toBeGreaterThan(1);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("tells a failed account list in place and still lets the owner be invited by email", async () => {
    stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list(OWNED), [`GET ${ACCOUNTS_PATH}`]: () => problem(429, "rate_limited", "req-429") } });
    await open();
    const dialog = await openDialog();

    expect(await within(dialog).findByText("The accounts could not be loaded")).toBeTruthy();
    expect(within(dialog).queryByRole("combobox", { name: "Account" })).toBeNull();
    await press(within(dialog).getByRole("radio", { name: "Invite by email" }));
    expect(within(dialog).getByRole("textbox", { name: "Email address" })).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("tells a failed creation in the dialog, never as created", async () => {
    stubAdminServer({
      routes: { [`GET ${LIST_PATH}`]: list(OWNED), [`GET ${ACCOUNTS_PATH}`]: accounts, [`POST ${LIST_PATH}`]: () => problem(503, "unavailable", "req-503") },
    });
    await open();
    const dialog = await openDialog();
    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Lab");
    await press(within(dialog).getByRole("radio", { name: "Invite by email" }));
    await typeInto(within(dialog).getByRole("textbox", { name: "Email address" }), "new@example.org");
    await press(within(dialog).getByRole("button", { name: "Create workspace" }));

    expect(await within(dialog).findByText("The workspace could not be created. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByText(/was created/)).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("adding myself as a member", () => {
  it("asks first, saying the owners will see it, and sends nothing when cancelled", async () => {
    const server = stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list(OWNED) } });
    await open();

    await chooseAction("Analytical Engines", "Add me as member");
    const confirm = await screen.findByRole("alertdialog", { name: "Add yourself to Analytical Engines?" });
    expect(confirm.textContent).toContain("Its owners will see in the workspace's activity that an instance admin joined.");
    await press(within(confirm).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(server.received("POST", `${LIST_PATH}/${OWNED.id}/membership`)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("joins once confirmed, says so and reads the list and the account again", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: [list(OWNED), list({ ...OWNED, memberCount: 5 })],
        [`POST ${LIST_PATH}/${OWNED.id}/membership`]: () => json({ workspaceId: OWNED.id, role: "member" }, { status: 201 }),
      },
    });
    await open();

    await chooseAction("Analytical Engines", "Add me as member");
    const confirm = await screen.findByRole("alertdialog", { name: "Add yourself to Analytical Engines?" });
    await press(within(confirm).getByRole("button", { name: "Add me as member" }));

    expect((await screen.findAllByText("You are now a member of Analytical Engines.")).length).toBeGreaterThan(0);
    expect(server.received("POST", `${LIST_PATH}/${OWNED.id}/membership`)).toHaveLength(1);
    expect(await within(await rowOf("Analytical Engines")).findByText("5")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains that the admin is a member already, and reads the list again", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: list(OWNED),
        [`POST ${LIST_PATH}/${OWNED.id}/membership`]: () => problem(409, "already_member", "req-409"),
      },
    });
    await open();

    await chooseAction("Analytical Engines", "Add me as member");
    const confirm = await screen.findByRole("alertdialog", { name: "Add yourself to Analytical Engines?" });
    await press(within(confirm).getByRole("button", { name: "Add me as member" }));

    expect((await screen.findAllByText("You are already a member of this workspace.")).length).toBeGreaterThan(0);
    expect(screen.queryByText("You are now a member of Analytical Engines.")).toBeNull();
    await waitFor(() => {
      expect(server.received("GET", LIST_PATH).length).toBeGreaterThan(1);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("asks for the re-authentication, and tells that nothing was changed when the prompt is closed", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: list(OWNED),
        [`POST ${LIST_PATH}/${OWNED.id}/membership`]: () => problem(401, "reauth_required", "req-reauth"),
      },
    });
    await open();

    await chooseAction("Analytical Engines", "Add me as member");
    const confirm = await screen.findByRole("alertdialog", { name: "Add yourself to Analytical Engines?" });
    await press(within(confirm).getByRole("button", { name: "Add me as member" }));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await press(within(prompt).getByRole("button", { name: "Cancel" }));

    expect((await screen.findAllByText("Confirm it is you to join the workspace. Nothing was changed.")).length).toBeGreaterThan(0);
    expect(screen.queryByText("You are now a member of Analytical Engines.")).toBeNull();
    expect(server.received("POST", `${LIST_PATH}/${OWNED.id}/membership`)).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("deleting a workspace", () => {
  async function openDelete(name = "Analytical Engines"): Promise<HTMLElement> {
    await chooseAction(name, "Delete workspace");
    return screen.findByRole("alertdialog", { name: `Delete ${name}?` });
  }

  it("sends nothing until the exact name is typed, and says the deletion is irreversible", async () => {
    const server = stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list(OWNED) } });
    await open();
    const dialog = await openDelete();

    expect(dialog.textContent).toContain("This is irreversible.");
    const submit = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Delete workspace" });
    expect(submit.disabled).toBe(true);
    await typeInto(within(dialog).getByRole("textbox", { name: "Type Analytical Engines to confirm" }), "analytical engines");
    expect(submit.disabled).toBe(true);
    await typeInto(within(dialog).getByRole("textbox", { name: "Type Analytical Engines to confirm" }), "Analytical Engines");
    expect(submit.disabled).toBe(false);
    expect(server.received("DELETE", `${LIST_PATH}/${OWNED.id}`)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("deletes it after the re-authentication the server asks for, and takes it off the list", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: [list(OWNED, PENDING), list(PENDING)],
        [`DELETE ${LIST_PATH}/${OWNED.id}`]: [() => problem(401, "reauth_required", "req-reauth"), () => new Response(null, { status: 202 })],
        [`POST ${REAUTH_PATH}`]: () => new Response(null, { status: 204 }),
      },
    });
    await open();
    const dialog = await openDelete();
    await typeInto(within(dialog).getByRole("textbox", { name: "Type Analytical Engines to confirm" }), "Analytical Engines");
    await press(within(dialog).getByRole("button", { name: "Delete workspace" }));

    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(screen.queryByText("Analytical Engines is being deleted")).toBeNull();
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await press(within(prompt).getByRole("button", { name: "Confirm" }));

    expect((await screen.findAllByText("Analytical Engines is being deleted")).length).toBeGreaterThan(0);
    expect(server.received("POST", REAUTH_PATH).map(({ body }) => body)).toEqual([{ password: "old password 1" }]);
    expect(server.received("DELETE", `${LIST_PATH}/${OWNED.id}`)).toHaveLength(2);
    await waitFor(() => {
      expect(screen.queryByText("Analytical Engines", { selector: "td *, td" })).toBeNull();
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the dialog and says nothing was sent when the re-authentication prompt is closed", async () => {
    const server = stubAdminServer({
      routes: { [`GET ${LIST_PATH}`]: list(OWNED), [`DELETE ${LIST_PATH}/${OWNED.id}`]: () => problem(401, "reauth_required", "req-reauth") },
    });
    await open();
    const dialog = await openDelete();
    await typeInto(within(dialog).getByRole("textbox", { name: "Type Analytical Engines to confirm" }), "Analytical Engines");
    await press(within(dialog).getByRole("button", { name: "Delete workspace" }));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await press(within(prompt).getByRole("button", { name: "Cancel" }));

    expect(await within(dialog).findByText("Confirm it is you to delete the workspace.")).toBeTruthy();
    expect(screen.queryByText("Analytical Engines is being deleted")).toBeNull();
    expect(server.received("DELETE", `${LIST_PATH}/${OWNED.id}`)).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains a refusal of the deletion guard and offers nothing but closing it", async () => {
    stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list(OWNED), [`DELETE ${LIST_PATH}/${OWNED.id}`]: () => problem(409, "billing_active", "req-409") } });
    await open();
    const dialog = await openDelete();
    await typeInto(within(dialog).getByRole("textbox", { name: "Type Analytical Engines to confirm" }), "Analytical Engines");
    await press(within(dialog).getByRole("button", { name: "Delete workspace" }));

    const blocked = await screen.findByRole("dialog", { name: "Analytical Engines cannot be deleted yet" });
    expect(blocked.textContent).toContain("This workspace has an active paid subscription.");
    expect(within(blocked).queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Analytical Engines is being deleted")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("tells a workspace that is gone already, closes the dialog and reads the list again", async () => {
    const server = stubAdminServer({
      routes: { [`GET ${LIST_PATH}`]: list(OWNED), [`DELETE ${LIST_PATH}/${OWNED.id}`]: () => problem(404, "not_found", "req-404") },
    });
    await open();
    const dialog = await openDelete();
    await typeInto(within(dialog).getByRole("textbox", { name: "Type Analytical Engines to confirm" }), "Analytical Engines");
    await press(within(dialog).getByRole("button", { name: "Delete workspace" }));

    expect((await screen.findAllByText("This workspace no longer exists or is already being deleted.")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(screen.queryByText("Analytical Engines is being deleted")).toBeNull();
    await waitFor(() => {
      expect(server.received("GET", LIST_PATH).length).toBeGreaterThan(1);
    });
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("re-issuing an owner invitation", () => {
  const INVITE_PATH = `${LIST_PATH}/${PENDING.id}/owner-invitation`;
  const INVITATION = { id: "0192f3a0-eeee-7000-8000-000000000002", email: "first@example.org", expiresAt: "2026-12-01T00:00:00Z" };

  async function openInvite(): Promise<HTMLElement> {
    await chooseAction("Waiting Room", "Re-issue owner invitation");
    return screen.findByRole("dialog", { name: "Re-issue the owner invitation for Waiting Room" });
  }

  it("is offered only for a workspace that waits for its first owner", async () => {
    stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list(OWNED, PENDING) } });
    await open();

    const owned = await rowOf("Analytical Engines");
    await press(within(owned).getByRole("button", { name: "Actions for Analytical Engines" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Add me as member", "Delete workspace"]);
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    });
    await press(within(await rowOf("Waiting Room")).getByRole("button", { name: "Actions for Waiting Room" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Add me as member", "Re-issue owner invitation", "Delete workspace"]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("issues it without an address, so the previous one is used, and says it was mailed", async () => {
    const server = stubAdminServer({
      routes: { [`GET ${LIST_PATH}`]: list(PENDING), [`POST ${INVITE_PATH}`]: () => json({ ...INVITATION, link: null }, { status: 201 }), [`POST ${REAUTH_PATH}`]: () => new Response(null, { status: 204 }) },
    });
    await open();
    const dialog = await openInvite();
    await press(within(dialog).getByRole("button", { name: "Re-issue invitation" }));

    expect((await screen.findAllByText("The owner invitation was mailed to first@example.org.")).length).toBeGreaterThan(0);
    expect(server.received("POST", INVITE_PATH).map(({ body }) => body)).toEqual([{}]);
    expect(screen.queryByRole("textbox", { name: "Owner invitation link" })).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Re-issue the owner invitation for Waiting Room" })).toBeNull();
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("sends the new address, and shows the link once where mail is not configured", async () => {
    const server = stubAdminServer({
      routes: { [`GET ${LIST_PATH}`]: list(PENDING), [`POST ${INVITE_PATH}`]: () => json({ ...INVITATION, email: "other@example.org", link: "http://localhost:3000/invite/xyz" }, { status: 201 }) },
    });
    await open();
    const dialog = await openInvite();
    await typeInto(within(dialog).getByRole("textbox", { name: "Email address" }), "other@example.org");
    await press(within(dialog).getByRole("button", { name: "Re-issue invitation" }));

    const link = await within(dialog).findByRole<HTMLInputElement>("textbox", { name: "Owner invitation link" });
    expect(link.value).toBe("http://localhost:3000/invite/xyz");
    expect(server.received("POST", INVITE_PATH).map(({ body }) => body)).toEqual([{ ownerEmail: "other@example.org" }]);
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled).toBe(true);
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains in place that the workspace has an owner by now, and reads the list again", async () => {
    const server = stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list(PENDING), [`POST ${INVITE_PATH}`]: () => problem(409, "workspace_has_owner", "req-409") } });
    await open();
    const dialog = await openInvite();
    await press(within(dialog).getByRole("button", { name: "Re-issue invitation" }));

    expect(await within(dialog).findByText("This workspace has an owner by now, so it needs no invitation.")).toBeTruthy();
    await waitFor(() => {
      expect(server.received("GET", LIST_PATH).length).toBeGreaterThan(1);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains in place that an address is needed when there is no earlier invitation", async () => {
    stubAdminServer({
      routes: {
        [`GET ${LIST_PATH}`]: list(PENDING),
        [`POST ${INVITE_PATH}`]: () =>
          json({ type: "t", title: "t", status: 422, code: "validation_failed", detail: "d", requestId: "req-422", errors: [{ path: "ownerEmail", code: "owner_email_required" }] }, { status: 422, contentType: "application/problem+json" }),
      },
    });
    await open();
    const dialog = await openInvite();
    await press(within(dialog).getByRole("button", { name: "Re-issue invitation" }));

    expect(await within(dialog).findByText("This workspace has no earlier invitation to take the address from. Enter the address to invite.")).toBeTruthy();
    expect(screen.queryByText(/was mailed/)).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says nothing was sent when the re-authentication prompt is closed", async () => {
    const server = stubAdminServer({ routes: { [`GET ${LIST_PATH}`]: list(PENDING), [`POST ${INVITE_PATH}`]: () => problem(401, "reauth_required", "req-reauth") } });
    await open();
    const dialog = await openInvite();
    await press(within(dialog).getByRole("button", { name: "Re-issue invitation" }));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await press(within(prompt).getByRole("button", { name: "Cancel" }));

    expect(await within(dialog).findByText("Confirm it is you to issue the invitation. Nothing was sent.")).toBeTruthy();
    expect(screen.queryByText(/was mailed/)).toBeNull();
    expect(server.received("POST", INVITE_PATH)).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);
});
