import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { GRACE, MEMBERS_PATH, SELF, WORKSPACE_PATH, stubWorkspaceSettingsServer, type TestMember } from "./workspace-settings-server.ts";

// Transferring the ownership of the workspace (doc 03 section 11.7, doc 02 section 3.3, doc 10 T18). The failure
// scenarios are a transfer that is sent before the recipient's name was typed, a transfer that is sent without the
// fresh re-authentication the server asks for or that is shown as done when the prompt was closed, a caller who steps
// down and keeps being offered what only an owner may do, a refusal or failure shown as a success, and a row action
// offered to somebody who may not transfer.

const SLOW_TEST_TIMEOUT_MS = 30_000;
const TRANSFER_PATH = `${WORKSPACE_PATH}/transfer-ownership`;
const REAUTH_PATH = "/api/v1/me/reauth";

const HEDY: TestMember = {
  accountId: "0192f3a0-bbbb-7000-8000-000000000003",
  displayName: "Hedy Lamarr",
  email: "hedy@example.org",
  role: "admin",
  joinedAt: "2026-09-10T08:00:00.000Z",
  lastActiveAt: "2026-10-17T10:00:00.000Z",
  teams: [],
};

const KATHERINE: TestMember = {
  accountId: "0192f3a0-bbbb-7000-8000-000000000004",
  displayName: "Katherine Johnson",
  email: "katherine@example.org",
  role: "owner",
  joinedAt: "2026-08-01T08:00:00.000Z",
  lastActiveAt: null,
  teams: [],
};

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function openList(): Promise<void> {
  window.history.replaceState(null, "", "/settings/workspace/members");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("table", { name: "Members" });
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table", { name: "Members" }))
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(name) !== null);
  if (row === undefined) {
    throw new Error(`no row for ${name}`);
  }
  return row;
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function menuOf(name: string): Promise<(string | null)[]> {
  await press(within(rowOf(name)).getByRole("button", { name: `Actions for ${name}` }));
  const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
  // The menu is closed again, so the next one read holds its own items only.
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  return items;
}

async function openTransfer(name: string): Promise<HTMLElement> {
  await press(within(rowOf(name)).getByRole("button", { name: `Actions for ${name}` }));
  await press(await screen.findByRole("menuitem", { name: "Transfer ownership" }));
  return screen.findByRole("alertdialog", { name: `Transfer ownership to ${name}?` });
}

async function typeName(dialog: HTMLElement, name: string, typed = name): Promise<void> {
  await act(async () => {
    fireEvent.change(within(dialog).getByRole("textbox", { name: `Type ${name} to confirm` }), { target: { value: typed } });
    await Promise.resolve();
  });
}

function submit(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("button", { name: "Transfer ownership" });
}

describe("the Transfer ownership row action", () => {
  it.each([
    ["a member", "Grace Hopper", ["Make owner", "Make admin", "Manage teams", "Transfer ownership", "Remove from workspace"]],
    ["an admin", "Hedy Lamarr", ["Make owner", "Make member", "Manage teams", "Transfer ownership", "Remove from workspace"]],
  ])("is offered to an owner for %s, between the role actions and Remove", async (_who, name, items) => {
    stubWorkspaceSettingsServer({ members: [SELF, GRACE, HEDY, KATHERINE] });
    await openList();

    expect(await menuOf(name)).toEqual(items);
  }, SLOW_TEST_TIMEOUT_MS);

  it("is not offered for an owner, whom an owner can only remove, nor on the caller's own row", async () => {
    stubWorkspaceSettingsServer({ members: [SELF, GRACE, KATHERINE] });
    await openList();

    expect(await menuOf("Katherine Johnson")).toEqual(["Make admin", "Make member", "Manage teams", "Remove from workspace"]);
    expect(within(rowOf("Ada Lovelace")).getByRole("button", { name: "Actions for Ada Lovelace" })).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("is not offered to an admin, who cannot transfer ownership", async () => {
    stubWorkspaceSettingsServer({ role: "admin", members: [{ ...SELF, role: "admin" }, GRACE, HEDY] });
    await openList();

    expect(await menuOf("Grace Hopper")).toEqual(["Make admin", "Manage teams", "Remove from workspace"]);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the transfer dialog", () => {
  it("asks for the recipient's name, offers to stay as admin and sends nothing until it is typed", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE] });
    await openList();

    const dialog = await openTransfer("Grace Hopper");

    expect(dialog.textContent).toContain("Grace Hopper becomes an owner of this workspace");
    expect(within(dialog).getByRole("checkbox", { name: "Stay as admin" }).getAttribute("aria-checked")).toBe("false");
    expect(submit(dialog).hasAttribute("disabled")).toBe(true);
    await typeName(dialog, "Grace Hopper", "grace hopper");
    expect(submit(dialog).hasAttribute("disabled")).toBe(true);
    await typeName(dialog, "Grace Hopper", "Grace Hop");
    expect(submit(dialog).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      fireEvent.submit(within(dialog).getByRole("textbox").closest("form") ?? dialog);
      await Promise.resolve();
    });
    expect(server.received("POST", TRANSFER_PATH)).toHaveLength(0);
    const results = await axe(document.body, { rules: { region: { enabled: false } } });
    expect(results.violations.map(({ id }) => id)).toEqual([]);

    await typeName(dialog, "Grace Hopper");
    expect(submit(dialog).hasAttribute("disabled")).toBe(false);
  }, SLOW_TEST_TIMEOUT_MS);

  it("transfers with the caller staying an owner by default, reloads the list and says so", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE] });
    await openList();
    const before = server.received("GET", MEMBERS_PATH).length;
    const dialog = await openTransfer("Grace Hopper");

    await typeName(dialog, "Grace Hopper");
    await press(submit(dialog));

    expect(await screen.findByText("Grace Hopper is now an owner of the workspace")).toBeTruthy();
    expect(server.received("POST", TRANSFER_PATH).map(({ body }) => body)).toEqual([{ accountId: GRACE.accountId, demoteSelf: false }]);
    await waitFor(() => {
      expect(within(rowOf("Grace Hopper")).getByText("Owner")).toBeTruthy();
    });
    expect(server.received("GET", MEMBERS_PATH).length).toBeGreaterThan(before);
    expect(within(rowOf("Ada Lovelace")).getByText("Owner")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("steps the caller down to admin when Stay as admin is on, and the page stops offering what only an owner may do", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE, HEDY] });
    await openList();
    const dialog = await openTransfer("Grace Hopper");

    await press(within(dialog).getByRole("checkbox", { name: "Stay as admin" }));
    await typeName(dialog, "Grace Hopper");
    await press(submit(dialog));

    expect(await screen.findByText("Grace Hopper is now an owner of the workspace, and you are an admin")).toBeTruthy();
    expect(server.received("POST", TRANSFER_PATH).map(({ body }) => body)).toEqual([{ accountId: GRACE.accountId, demoteSelf: true }]);
    await waitFor(() => {
      expect(within(rowOf("Ada Lovelace")).getByText("Admin")).toBeTruthy();
    });
    // an admin cannot touch an owner, so the new owner has only the teams left to manage, while a member still has more
    expect(await menuOf("Grace Hopper")).toEqual(["Manage teams"]);
    expect(await menuOf("Hedy Lamarr")).toEqual(["Make member", "Manage teams", "Remove from workspace"]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("opens the re-authentication prompt on reauth_required, and sends the transfer again once the password is confirmed", async () => {
    const server = stubWorkspaceSettingsServer({
      members: [SELF, GRACE],
      transfer: (call) => (call === 1 ? problem(401, "reauth_required", "req-reauth") : json({ ...GRACE, role: "owner" })),
      other: () => Promise.resolve(new Response(null, { status: 204 })),
    });
    await openList();
    const dialog = await openTransfer("Grace Hopper");
    await typeName(dialog, "Grace Hopper");

    await press(submit(dialog));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(screen.queryByText("Grace Hopper is now an owner of the workspace")).toBeNull();
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await press(within(prompt).getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Grace Hopper is now an owner of the workspace")).toBeTruthy();
    expect(server.received("POST", REAUTH_PATH).map(({ body }) => body)).toEqual([{ password: "old password 1" }]);
    expect(server.received("POST", TRANSFER_PATH)).toHaveLength(2);
  }, SLOW_TEST_TIMEOUT_MS);

  it("tells the member nothing was sent when they close the re-authentication prompt, and keeps the dialog", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE], transfer: () => problem(401, "reauth_required", "req-reauth") });
    await openList();
    const dialog = await openTransfer("Grace Hopper");
    await typeName(dialog, "Grace Hopper");

    await press(submit(dialog));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await press(within(prompt).getByRole("button", { name: "Cancel" }));

    expect(await within(dialog).findByText("Confirm it is you to transfer ownership.")).toBeTruthy();
    expect(screen.queryByText("Grace Hopper is now an owner of the workspace")).toBeNull();
    expect(server.received("POST", TRANSFER_PATH)).toHaveLength(1);
    await waitFor(() => {
      expect(submit(dialog).hasAttribute("disabled")).toBe(false);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it.each([
    ["409 last_owner", () => problem(409, "last_owner", "req-409"), "A workspace needs at least one owner. The ownership was not changed."],
    ["403", () => problem(403, "forbidden", "req-403"), "Only an owner can transfer ownership. The page has been reloaded."],
    ["404", () => problem(404, "not_found", "req-404"), "This person is no longer a member of the workspace. The list has been reloaded."],
  ])("explains a refusal with %s, changes nothing and loads the list again", async (_name, answer, message) => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE], transfer: answer });
    await openList();
    const before = server.received("GET", MEMBERS_PATH).length;
    const dialog = await openTransfer("Grace Hopper");
    await typeName(dialog, "Grace Hopper");

    await press(submit(dialog));

    expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/is now an owner of the workspace/)).toBeNull();
    await waitFor(() => {
      expect(server.received("GET", MEMBERS_PATH).length).toBeGreaterThan(before);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(within(rowOf("Grace Hopper")).queryByText("Owner")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("reports another failure in an error toast, keeps the dialog and lets the member try again", async () => {
    const server = stubWorkspaceSettingsServer({
      members: [SELF, GRACE],
      transfer: (call) => (call === 1 ? problem(503, "unavailable", "req-503") : json({ ...GRACE, role: "owner" })),
    });
    await openList();
    const dialog = await openTransfer("Grace Hopper");
    await typeName(dialog, "Grace Hopper");

    await press(submit(dialog));

    expect((await screen.findAllByText("req-503", { exact: false })).length).toBeGreaterThan(0);
    expect(screen.queryByText("Grace Hopper is now an owner of the workspace")).toBeNull();
    await waitFor(() => {
      expect(submit(dialog).hasAttribute("disabled")).toBe(false);
    });
    await press(submit(dialog));
    expect(await screen.findByText("Grace Hopper is now an owner of the workspace")).toBeTruthy();
    expect(server.received("POST", TRANSFER_PATH)).toHaveLength(2);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the wait on the button and does not send a second request", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubWorkspaceSettingsServer({
      members: [SELF, GRACE],
      transfer: async () => {
        await gate;
        return json({ ...GRACE, role: "owner" });
      },
    });
    await openList();
    const dialog = await openTransfer("Grace Hopper");
    await typeName(dialog, "Grace Hopper");

    await press(submit(dialog));

    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: /^Transfer ownership/ }).hasAttribute("data-loading")).toBe(true);
    });
    fireEvent.submit(within(dialog).getByRole("textbox").closest("form") ?? dialog);
    expect(server.received("POST", TRANSFER_PATH)).toHaveLength(1);
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("sends nothing when the member cancels", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE] });
    await openList();
    const dialog = await openTransfer("Grace Hopper");
    await typeName(dialog, "Grace Hopper");

    await press(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(server.received("POST", TRANSFER_PATH)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);
});
