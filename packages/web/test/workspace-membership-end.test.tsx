import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { GRACE, MEMBERS_PATH, SELF, WORKSPACE_PATH, stubWorkspaceSettingsServer, type TestMember } from "./workspace-settings-server.ts";

// Removing a member (doc 03 section 11.7) and leaving the workspace (section 11.6), both with the content choice of
// doc 02 section 3.6. The failure scenarios are a removal that is sent without the recipient the member chose, a
// confirmation that does not say what is lost, a last owner who is offered Leave, a departure that leaves the SPA in a
// workspace the account is no longer in, and a refusal or failure shown as a success.

const SLOW_TEST_TIMEOUT_MS = 30_000;
const LEAVE_PATH = `${WORKSPACE_PATH}/leave`;

const HEDY: TestMember = {
  accountId: "0192f3a0-bbbb-7000-8000-000000000003",
  displayName: "Hedy Lamarr",
  email: "hedy@example.org",
  role: "admin",
  joinedAt: "2026-09-10T08:00:00.000Z",
  lastActiveAt: "2026-10-17T10:00:00.000Z",
};

/** An owner who joined before the caller did. */
const OLD_OWNER: TestMember = {
  accountId: "0192f3a0-bbbb-7000-8000-000000000004",
  displayName: "Katherine Johnson",
  email: "katherine@example.org",
  role: "owner",
  joinedAt: "2026-08-01T08:00:00.000Z",
  lastActiveAt: null,
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

async function open(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function openList(): Promise<void> {
  await open("/settings/workspace/members");
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

async function openRemoval(name: string): Promise<HTMLElement> {
  await press(within(rowOf(name)).getByRole("button", { name: `Actions for ${name}` }));
  await press(await screen.findByRole("menuitem", { name: "Remove from workspace" }));
  return screen.findByRole("dialog", { name: `Remove ${name}` });
}

async function openPicker(dialog: HTMLElement): Promise<void> {
  const input = within(dialog).getByRole("combobox", { name: "Transfer to" });
  await act(async () => {
    // Base UI opens the list on a press that began on the input.
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
}

async function chooseRecipient(dialog: HTMLElement, name: string): Promise<void> {
  await openPicker(dialog);
  await press(await screen.findByRole("option", { name: new RegExp(name) }));
}

function recipientOf(dialog: HTMLElement): string {
  return within(dialog).getByRole<HTMLInputElement>("combobox", { name: "Transfer to" }).value;
}

describe("removing a member", () => {
  it("offers Remove to an owner on every other member and not on their own row", async () => {
    stubWorkspaceSettingsServer({ members: [SELF, GRACE, HEDY] });
    await openList();

    await press(within(rowOf("Grace Hopper")).getByRole("button", { name: "Actions for Grace Hopper" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Make owner", "Make admin", "Remove from workspace"]);
    expect(within(rowOf("Ada Lovelace")).getByRole("button", { name: "Actions for Ada Lovelace" })).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("offers an admin Remove for a member and neither a menu nor Remove for an owner", async () => {
    stubWorkspaceSettingsServer({ role: "admin", members: [{ ...SELF, role: "admin" }, { ...OLD_OWNER }, GRACE] });
    await openList();

    expect(within(rowOf("Katherine Johnson")).queryByRole("button", { name: /^Actions for/ })).toBeNull();
    await press(within(rowOf("Grace Hopper")).getByRole("button", { name: "Actions for Grace Hopper" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Make admin", "Remove from workspace"]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("starts at transferring the content to the member who removes, then asks to confirm and says what is lost", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE, HEDY] });
    await openList();

    const dialog = await openRemoval("Grace Hopper");

    expect(within(dialog).getByRole("radio", { name: "Transfer the content" }).getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByRole("radio", { name: "Delete the content" }).getAttribute("aria-checked")).toBe("false");
    expect(recipientOf(dialog)).toBe("Ada Lovelace");
    expect(server.received("DELETE", `${MEMBERS_PATH}/${GRACE.accountId}`)).toHaveLength(0);
    const results = await axe(document.body, { rules: { region: { enabled: false } } });
    expect(results.violations.map(({ id }) => id)).toEqual([]);

    await press(within(dialog).getByRole("button", { name: "Continue" }));

    const confirm = await screen.findByRole("alertdialog", { name: "Remove Grace Hopper?" });
    expect(confirm.textContent).toContain(
      "Grace Hopper loses access to this workspace right away, and their API tokens for it stop working. Their bookmarks and folders go to Ada Lovelace; their tags and go preferences are deleted. This cannot be undone.",
    );
    expect(server.received("DELETE", `${MEMBERS_PATH}/${GRACE.accountId}`)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("removes the member with the recipient that was picked, reloads the list and says so", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE, HEDY] });
    await openList();
    const before = server.received("GET", MEMBERS_PATH).length;
    const dialog = await openRemoval("Grace Hopper");

    await chooseRecipient(dialog, "Hedy Lamarr");
    expect(recipientOf(dialog)).toBe("Hedy Lamarr");
    await press(within(dialog).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Grace Hopper?" });
    expect(confirm.textContent).toContain("go to Hedy Lamarr;");
    await press(within(confirm).getByRole("button", { name: "Remove member" }));

    expect(await screen.findByText("Grace Hopper was removed from the workspace")).toBeTruthy();
    await waitFor(() => {
      expect(within(screen.getByRole("table", { name: "Members" })).queryByText("Grace Hopper")).toBeNull();
    });
    expect(server.received("DELETE", `${MEMBERS_PATH}/${GRACE.accountId}`).map(({ body }) => body)).toEqual([{ content: "transfer", transferTo: HEDY.accountId }]);
    expect(server.received("GET", MEMBERS_PATH).length).toBeGreaterThan(before);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("sends no recipient when the content is deleted, and the confirmation says it is deleted", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE, HEDY] });
    await openList();
    const dialog = await openRemoval("Grace Hopper");

    await press(within(dialog).getByRole("radio", { name: "Delete the content" }));
    expect(within(dialog).queryByRole("combobox", { name: "Transfer to" })).toBeNull();
    await press(within(dialog).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Grace Hopper?" });
    expect(confirm.textContent).toContain("Their bookmarks, folders, tags and go preferences are deleted.");
    await press(within(confirm).getByRole("button", { name: "Remove member" }));

    await waitFor(() => {
      expect(server.received("DELETE", `${MEMBERS_PATH}/${GRACE.accountId}`).map(({ body }) => body)).toEqual([{ content: "delete" }]);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("sends nothing when the member cancels", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE] });
    await openList();
    const dialog = await openRemoval("Grace Hopper");
    await press(within(dialog).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Grace Hopper?" });

    await press(within(confirm).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(server.received("DELETE", `${MEMBERS_PATH}/${GRACE.accountId}`)).toHaveLength(0);
    expect(within(screen.getByRole("table", { name: "Members" })).getByText("Grace Hopper")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the wait on the confirm button and does not send a second request", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubWorkspaceSettingsServer({
      members: [SELF, GRACE],
      memberDelete: async () => {
        await gate;
        return json({ content: "transfer", transferTo: SELF.accountId });
      },
    });
    await openList();
    const dialog = await openRemoval("Grace Hopper");
    await press(within(dialog).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Grace Hopper?" });

    await press(within(confirm).getByRole("button", { name: "Remove member" }));

    await waitFor(() => {
      expect(within(confirm).getByRole("button", { name: /^Remove member/ }).hasAttribute("data-loading")).toBe(true);
    });
    expect(within(confirm).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(confirm).getByRole("button", { name: /^Remove member/ }));
    expect(server.received("DELETE", `${MEMBERS_PATH}/${GRACE.accountId}`)).toHaveLength(1);
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains a refusal because the member is the last owner, changes nothing and loads the list again", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE], memberDelete: () => problem(409, "last_owner", "req-409") });
    await openList();
    const before = server.received("GET", MEMBERS_PATH).length;
    const dialog = await openRemoval("Grace Hopper");
    await press(within(dialog).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Grace Hopper?" });

    await press(within(confirm).getByRole("button", { name: "Remove member" }));

    expect((await screen.findAllByText("This person is the last owner of the workspace, so they cannot be removed. Make someone else an owner first.")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Grace Hopper was removed from the workspace")).toBeNull();
    await waitFor(() => {
      expect(server.received("GET", MEMBERS_PATH).length).toBeGreaterThan(before);
    });
    expect(within(screen.getByRole("table", { name: "Members" })).getByText("Grace Hopper")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says the chosen recipient is no longer a member when the server names transferTo", async () => {
    stubWorkspaceSettingsServer({
      members: [SELF, GRACE, HEDY],
      memberDelete: () =>
        json(
          { type: "x", title: "x", status: 404, code: "not_found", detail: "x", requestId: "req-404", errors: [{ path: "transferTo", code: "not_found" }] },
          { status: 404, contentType: "application/problem+json" },
        ),
    });
    await openList();
    const dialog = await openRemoval("Grace Hopper");
    await press(within(dialog).getByRole("button", { name: "Continue" }));
    await press(within(await screen.findByRole("alertdialog", { name: "Remove Grace Hopper?" })).getByRole("button", { name: "Remove member" }));

    expect((await screen.findAllByText("The person chosen to receive the content is no longer a member of the workspace. Choose someone else.")).length).toBeGreaterThan(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("reports another failure in an error toast, keeps the confirmation and lets the member try again", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE], memberDelete: (call) => (call === 1 ? problem(503, "unavailable", "req-503") : json({ content: "transfer", transferTo: SELF.accountId })) });
    await openList();
    const dialog = await openRemoval("Grace Hopper");
    await press(within(dialog).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Grace Hopper?" });

    await press(within(confirm).getByRole("button", { name: "Remove member" }));

    expect((await screen.findAllByText("req-503", { exact: false })).length).toBeGreaterThan(0);
    expect(screen.queryByText("Grace Hopper was removed from the workspace")).toBeNull();
    await waitFor(() => {
      expect(within(confirm).getByRole("button", { name: "Remove member" }).hasAttribute("disabled")).toBe(false);
    });
    await press(within(confirm).getByRole("button", { name: "Remove member" }));
    expect(await screen.findByText("Grace Hopper was removed from the workspace")).toBeTruthy();
    expect(server.received("DELETE", `${MEMBERS_PATH}/${GRACE.accountId}`)).toHaveLength(2);
  }, SLOW_TEST_TIMEOUT_MS);

  it("states in the picker that no member matches the search", async () => {
    stubWorkspaceSettingsServer({ members: [SELF, GRACE, HEDY] });
    await openList();
    const dialog = await openRemoval("Grace Hopper");
    await openPicker(dialog);

    await act(async () => {
      fireEvent.change(within(dialog).getByRole("combobox", { name: "Transfer to" }), { target: { value: "zzz" } });
      await Promise.resolve();
    });

    expect(await screen.findByText("No member matches")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("waits for every page of members before it offers recipients", async () => {
    stubWorkspaceSettingsServer({ members: [SELF, GRACE, HEDY], pageSize: 1 });
    await openList();
    await press(screen.getByRole("button", { name: "Show more" }));
    await within(screen.getByRole("table", { name: "Members" })).findByText("Grace Hopper");
    const dialog = await openRemoval("Grace Hopper");

    await waitFor(() => {
      expect(recipientOf(dialog)).toBe("Ada Lovelace");
    });
    await openPicker(dialog);
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Ada Lovelaceada@example.org", "Hedy Lamarrhedy@example.org"]);
  }, SLOW_TEST_TIMEOUT_MS);
});

async function openGeneral(): Promise<void> {
  await open("/settings/workspace");
  await screen.findByRole("heading", { level: 2, name: "Danger zone" });
}

async function openLeave(): Promise<HTMLElement> {
  await press(await screen.findByRole("button", { name: "Leave workspace" }));
  return screen.findByRole("dialog", { name: "Leave Ada's Workspace" });
}

const MEMBER_VIEW = [{ ...SELF, role: "member" as const }, { ...GRACE, role: "owner" as const }, OLD_OWNER];

describe("leaving the workspace", () => {
  it.each(["owner", "admin", "member"] as const)("is offered to a %s in the danger zone, with what it costs", async (role) => {
    stubWorkspaceSettingsServer({ role, members: [{ ...SELF, role }, { ...GRACE, role: "owner" }] });
    await openGeneral();

    const zone = screen.getByRole("heading", { level: 2, name: "Danger zone" }).closest("[data-slot=danger-zone]") as HTMLElement;
    expect(within(zone).getByText("You lose access to this workspace right away. You choose what happens to your bookmarks and folders.")).toBeTruthy();
    await waitFor(() => {
      expect(within(zone).getByRole("button", { name: "Leave workspace" }).hasAttribute("disabled")).toBe(false);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("starts at transferring to the longest-standing owner, asks to confirm, sends the choice and leaves for /no-workspace", async () => {
    const server = stubWorkspaceSettingsServer({ role: "member", members: MEMBER_VIEW, afterLeaving: "none" });
    await openGeneral();

    const dialog = await openLeave();

    expect(recipientOf(dialog)).toBe("Katherine Johnson");
    await press(within(dialog).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Leave Ada's Workspace?" });
    expect(confirm.textContent).toContain(
      "You lose access to this workspace right away, and your API tokens for it stop working. Your bookmarks and folders go to Katherine Johnson; your tags and go preferences are deleted. This cannot be undone.",
    );
    expect(server.received("POST", LEAVE_PATH)).toHaveLength(0);
    await press(within(confirm).getByRole("button", { name: "Leave workspace" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/no-workspace");
    });
    expect(server.received("POST", LEAVE_PATH).map(({ body }) => body)).toEqual([{ content: "transfer", transferTo: OLD_OWNER.accountId }]);
    expect(await screen.findByRole("heading", { name: "Waiting for an invitation" })).toBeTruthy();
    expect((await screen.findAllByText("You left Ada's Workspace")).length).toBeGreaterThan(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("deletes the content on request, sends no recipient and moves to the workspace the account is now in", async () => {
    const server = stubWorkspaceSettingsServer({
      role: "member",
      members: MEMBER_VIEW,
      afterLeaving: "other",
      other: (request) => Promise.reject(new Error(`unexpected call ${request.method} ${new URL(request.url).pathname}`)),
    });
    await openGeneral();
    const dialog = await openLeave();

    await press(within(dialog).getByRole("radio", { name: "Delete the content" }));
    await press(within(dialog).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Leave Ada's Workspace?" });
    expect(confirm.textContent).toContain("Your bookmarks, folders, tags and go preferences are deleted.");
    await press(within(confirm).getByRole("button", { name: "Leave workspace" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(server.received("POST", LEAVE_PATH).map(({ body }) => body)).toEqual([{ content: "delete" }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Danger zone" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("does not offer Leave to the last owner and says why, with a link to the members", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, GRACE] });
    await openGeneral();

    const link = await screen.findByRole("link", { name: "Transfer ownership first." });
    expect(link.getAttribute("href")).toBe("/settings/workspace/members");
    expect(screen.getByText("You are the last owner of this workspace, so you cannot leave it yet.", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Leave workspace" }).hasAttribute("disabled")).toBe(true);

    await press(screen.getByRole("button", { name: "Leave workspace" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.received("POST", LEAVE_PATH)).toHaveLength(0);

    await press(link);
    expect(await screen.findByRole("heading", { level: 1, name: "Members" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/workspace/members");
  }, SLOW_TEST_TIMEOUT_MS);

  it("lets an owner leave while another owner exists", async () => {
    stubWorkspaceSettingsServer({ members: [SELF, { ...GRACE, role: "owner" }] });
    await openGeneral();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Leave workspace" }).hasAttribute("disabled")).toBe(false);
    });
    expect(screen.queryByRole("link", { name: "Transfer ownership first." })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains a last-owner refusal of the server that the page did not know, and stays", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, { ...GRACE, role: "owner" }], leave: () => problem(409, "last_owner", "req-409") });
    await openGeneral();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Leave workspace" }).hasAttribute("disabled")).toBe(false);
    });
    const dialog = await openLeave();
    await press(within(dialog).getByRole("button", { name: "Continue" }));

    await press(within(await screen.findByRole("alertdialog", { name: "Leave Ada's Workspace?" })).getByRole("button", { name: "Leave workspace" }));

    expect((await screen.findAllByText("You are the last owner of this workspace, so you cannot leave it. Make someone else an owner first.")).length).toBeGreaterThan(0);
    expect(window.location.pathname).toBe("/settings/workspace");
    expect(server.received("POST", LEAVE_PATH)).toHaveLength(1);
    expect(screen.queryByText("You left Ada's Workspace")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("reports another failure in an error toast and stays in the workspace", async () => {
    stubWorkspaceSettingsServer({ role: "member", members: MEMBER_VIEW, leave: () => problem(503, "unavailable", "req-503") });
    await openGeneral();
    const dialog = await openLeave();
    await press(within(dialog).getByRole("button", { name: "Continue" }));

    await press(within(await screen.findByRole("alertdialog", { name: "Leave Ada's Workspace?" })).getByRole("button", { name: "Leave workspace" }));

    expect((await screen.findAllByText("req-503", { exact: false })).length).toBeGreaterThan(0);
    expect(window.location.pathname).toBe("/settings/workspace");
    expect(screen.queryByText("You left Ada's Workspace")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says the members could not be loaded, keeps Continue off for a transfer, and still allows deleting the content", async () => {
    const server = stubWorkspaceSettingsServer({ role: "member", members: MEMBER_VIEW, membersGet: () => problem(503, "unavailable", "req-503") });
    await openGeneral();
    const dialog = await openLeave();

    expect(await within(dialog).findByText("The members could not be loaded", undefined, { timeout: 8000 })).toBeTruthy();
    expect(within(dialog).queryByRole("combobox", { name: "Transfer to" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);

    await press(within(dialog).getByRole("radio", { name: "Delete the content" }));
    expect(within(dialog).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    expect(server.received("POST", LEAVE_PATH)).toHaveLength(0);
  }, 60_000);

  it("is a bottom drawer on a narrow screen", async () => {
    stubMatchMedia(true);
    stubWorkspaceSettingsServer({ role: "member", members: MEMBER_VIEW });
    await openGeneral();

    await press(await screen.findByRole("button", { name: "Leave workspace" }));

    const sheet = await screen.findByRole("dialog", { name: "Leave Ada's Workspace" });
    expect(within(sheet).getByRole("radio", { name: "Transfer the content" })).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);
});
