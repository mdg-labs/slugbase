import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { GRACE, MEMBERS_PATH, SELF, WORKSPACE_PATH, stubWorkspaceSettingsServer, type Role, type TestMember } from "./workspace-settings-server.ts";

// /settings/workspace/members (doc 03 section 11.7). The failure scenarios are a plain member who can open the page, a role
// Select that offers a role the viewer may not give, a refused change that is shown as made or not explained, a change of the
// caller's own role that leaves the session state as it was, and a list that failed to load shown as an empty one.

const SLOW_TEST_TIMEOUT_MS = 30_000;
const ME_PATH = "/api/v1/me";

const HEDY: TestMember = {
  accountId: "0192f3a0-bbbb-7000-8000-000000000003",
  displayName: "Hedy Lamarr",
  email: "hedy@example.org",
  role: "admin",
  joinedAt: "2026-09-10T08:00:00.000Z",
  lastActiveAt: "2026-10-17T10:00:00.000Z",
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

async function openMembers(): Promise<void> {
  window.history.replaceState(null, "", "/settings/workspace/members");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function openList(): Promise<void> {
  await openMembers();
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

async function choose(select: string, option: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox", { name: select }));
    await Promise.resolve();
  });
  await act(async () => {
    const found = await screen.findByRole("option", { name: option });
    // Base UI commits a click only after the press began on the item.
    fireEvent.pointerDown(found);
    fireEvent.click(found);
    await Promise.resolve();
  });
}

async function optionsOf(select: string): Promise<string[]> {
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox", { name: select }));
    await Promise.resolve();
  });
  const names = (await screen.findAllByRole("option")).map((option) => option.textContent);
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    await Promise.resolve();
  });
  return names;
}

describe("the Members navigation entry", () => {
  it.each<[Role, boolean]>([
    ["owner", true],
    ["admin", true],
    ["member", false],
  ])("for a %s: listed is %s", async (role, listed) => {
    stubWorkspaceSettingsServer({ role });
    window.history.replaceState(null, "", "/settings/workspace");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);

    const group = await screen.findByRole("list", { name: "Workspace" });
    await within(group).findByRole("link", { name: "General" });

    expect(within(group).getAllByRole("link").map((link) => link.textContent)).toEqual(listed ? ["General", "Members"] : ["General"]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("opens the members page", async () => {
    stubWorkspaceSettingsServer();
    window.history.replaceState(null, "", "/settings/workspace");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    const group = await screen.findByRole("list", { name: "Workspace" });

    await act(async () => {
      fireEvent.click(await within(group).findByRole("link", { name: "Members" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Members" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/workspace/members");
    expect(within(screen.getByRole("list", { name: "Workspace" })).getByRole("link", { name: "Members" }).getAttribute("aria-current")).toBe("page");
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the members table", () => {
  it("lists name, email, role, joined and last active, and marks the caller", async () => {
    stubWorkspaceSettingsServer({ members: [SELF, GRACE, HEDY] });
    await openList();

    const columns = within(screen.getByRole("table", { name: "Members" })).getAllByRole("columnheader").map((header) => header.textContent);
    expect(columns).toEqual(["Name", "Email", "Role", "Joined", "Last active", "Actions"]);
    const cells = (name: string): string[] => within(rowOf(name)).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells("Ada Lovelace").slice(0, 2)).toEqual(["ALAda LovelaceYou", "ada@example.org"]);
    expect(cells("Ada Lovelace")[3]).toContain("2026");
    expect(cells("Ada Lovelace")[4]).toContain("2026");
    expect(cells("Grace Hopper")[1]).toBe("grace@example.org");
    expect(cells("Grace Hopper")[4]).toBe("Never");
    expect(within(rowOf("Grace Hopper")).getByRole("combobox", { name: "Role of Grace Hopper" }).textContent).toContain("Member");
  });

  it("offers an owner every role, and an admin neither Owner nor a change to an owner", async () => {
    stubWorkspaceSettingsServer({ role: "owner", members: [SELF, GRACE, HEDY] });
    await openList();
    expect(await optionsOf("Role of Grace Hopper")).toEqual(["Owner", "Admin", "Member"]);
  });

  it("gives an admin Admin and Member only, and no Select for an owner", async () => {
    stubWorkspaceSettingsServer({ role: "admin", members: [{ ...SELF, role: "admin" }, { ...HEDY, role: "owner" }, GRACE] });
    await openList();

    expect(await optionsOf("Role of Grace Hopper")).toEqual(["Admin", "Member"]);
    expect(within(rowOf("Hedy Lamarr")).queryByRole("combobox")).toBeNull();
    expect(within(rowOf("Hedy Lamarr")).getByText("Owner")).toBeTruthy();
    expect(within(rowOf("Hedy Lamarr")).queryByRole("button", { name: /^Actions for/ })).toBeNull();
  });

  it("changes a role from the Select, sends only that role and shows the answer", async () => {
    const server = stubWorkspaceSettingsServer();
    await openList();

    await choose("Role of Grace Hopper", "Admin");

    await waitFor(() => {
      expect(within(rowOf("Grace Hopper")).getByRole("combobox", { name: "Role of Grace Hopper" }).textContent).toContain("Admin");
    });
    expect(server.received("PATCH", `${MEMBERS_PATH}/${GRACE.accountId}`).map(({ body }) => body)).toEqual([{ role: "admin" }]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("changes a role from the row actions", async () => {
    const server = stubWorkspaceSettingsServer();
    await openList();

    await act(async () => {
      fireEvent.click(within(rowOf("Grace Hopper")).getByRole("button", { name: "Actions for Grace Hopper" }));
      await Promise.resolve();
    });
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(items).toEqual(["Make owner", "Make admin", "Transfer ownership", "Remove from workspace"]);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Make owner" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(within(rowOf("Grace Hopper")).getByRole("combobox", { name: "Role of Grace Hopper" }).textContent).toContain("Owner");
    });
    expect(server.received("PATCH", `${MEMBERS_PATH}/${GRACE.accountId}`).map(({ body }) => body)).toEqual([{ role: "owner" }]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains in place that the last owner cannot be demoted, and keeps the role", async () => {
    stubWorkspaceSettingsServer();
    await openList();

    await choose("Role of Ada Lovelace", "Member");

    expect(await screen.findByText("A workspace needs at least one owner. Make someone else an owner first.")).toBeTruthy();
    expect(within(rowOf("Ada Lovelace")).getByRole("combobox", { name: "Role of Ada Lovelace" }).textContent).toContain("Owner");
    expect(screen.queryByText("That did not work", { exact: false })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains in place a change the server forbade, and loads the workspace again", async () => {
    const server = stubWorkspaceSettingsServer({ memberPatch: () => problem(403, "forbidden", "req-403") });
    await openList();
    const before = server.received("GET", WORKSPACE_PATH).length;

    await choose("Role of Grace Hopper", "Admin");

    expect(await screen.findByText("You are not allowed to change this role.")).toBeTruthy();
    expect(within(rowOf("Grace Hopper")).getByRole("combobox", { name: "Role of Grace Hopper" }).textContent).toContain("Member");
    await waitFor(() => {
      expect(server.received("GET", WORKSPACE_PATH).length).toBeGreaterThan(before);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("says a member who left is no longer a member, and loads the list again", async () => {
    const server = stubWorkspaceSettingsServer({ memberPatch: () => problem(404, "not_found", "req-404") });
    await openList();
    const before = server.received("GET", MEMBERS_PATH).length;

    await choose("Role of Grace Hopper", "Admin");

    expect(await screen.findByText("This person is no longer a member of the workspace.")).toBeTruthy();
    await waitFor(() => {
      expect(server.received("GET", MEMBERS_PATH).length).toBeGreaterThan(before);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("reports another failure in an error toast and keeps the role", async () => {
    stubWorkspaceSettingsServer({ memberPatch: () => problem(503, "unavailable", "req-503") });
    await openList();

    await choose("Role of Grace Hopper", "Admin");

    expect((await screen.findAllByText("req-503", { exact: false })).length).toBeGreaterThan(0);
    expect(within(rowOf("Grace Hopper")).getByRole("combobox", { name: "Role of Grace Hopper" }).textContent).toContain("Member");
  }, SLOW_TEST_TIMEOUT_MS);

  it("refreshes the session state when the caller changes their own role, and moves a caller who became a member to the 403 page", async () => {
    const server = stubWorkspaceSettingsServer({ members: [SELF, { ...GRACE, role: "owner" }] });
    await openList();
    const meBefore = server.received("GET", ME_PATH).length;
    const workspaceBefore = server.received("GET", WORKSPACE_PATH).length;

    await choose("Role of Ada Lovelace", "Admin");

    await waitFor(() => {
      expect(server.received("GET", ME_PATH).length).toBeGreaterThan(meBefore);
    });
    expect(server.received("GET", WORKSPACE_PATH).length).toBeGreaterThan(workspaceBefore);
    // An admin still manages the members, is offered no Owner option, and cannot touch the other owner.
    await waitFor(() => {
      expect(within(rowOf("Grace Hopper")).queryByRole("combobox")).toBeNull();
    });
    expect(await optionsOf("Role of Ada Lovelace")).toEqual(["Admin", "Member"]);

    await choose("Role of Ada Lovelace", "Member");

    expect(await screen.findByRole("heading", { name: "You don't have access" })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Members" })).toBeNull();
    await waitFor(() => {
      expect(within(screen.getByRole("list", { name: "Workspace" })).queryByRole("link", { name: "Members" })).toBeNull();
    });
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the states of the members page", () => {
  it("has no axe violations", async () => {
    stubWorkspaceSettingsServer({ members: [SELF, GRACE, HEDY] });
    await openList();

    const results = await axe(document.body, { rules: { region: { enabled: false } } });

    expect(results.violations.map(({ id }) => id)).toEqual([]);
  });

  it("shows a loading skeleton until the list arrives", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubWorkspaceSettingsServer({
      membersGet: async () => {
        await gate;
        return json({ items: [SELF, GRACE], nextCursor: null });
      },
    });
    await openMembers();

    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Members" })).toBeNull();
    await act(async () => {
      release();
      await gate;
    });
    expect(await screen.findByRole("table", { name: "Members" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says the list could not be loaded instead of showing it as empty, and loads it again on retry", async () => {
    stubWorkspaceSettingsServer({ membersGet: (call) => (call <= 3 ? problem(503, "unavailable", "req-503") : json({ items: [SELF, GRACE], nextCursor: null })) });
    await openMembers();

    expect(await screen.findByText("The members could not be loaded", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Members" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("table", { name: "Members" })).toBeTruthy();
    expect(screen.queryByText("The members could not be loaded")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says so when the caller is the only member", async () => {
    stubWorkspaceSettingsServer({ members: [SELF] });
    await openList();

    expect(screen.getByText("You are the only member")).toBeTruthy();
    expect(within(rowOf("Ada Lovelace")).getAllByRole("cell")).toHaveLength(6);
  });

  it("does not call a page of two members the only member, and loads the next page on request", async () => {
    stubWorkspaceSettingsServer({ pageSize: 1 });
    await openList();

    expect(screen.queryByText("You are the only member")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      await Promise.resolve();
    });

    expect(await within(screen.getByRole("table", { name: "Members" })).findByText("Grace Hopper")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the in-app 403 page to a plain member, who asks for no member list", async () => {
    const server = stubWorkspaceSettingsServer({ role: "member" });
    await openMembers();

    expect(await screen.findByRole("heading", { name: "You don't have access" })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Members" })).toBeNull();
    expect(server.received("GET", MEMBERS_PATH)).toHaveLength(0);
  });

  it("lists each member as a card on a narrow screen, with the role Select and the row actions in it", async () => {
    stubMatchMedia(true);
    const server = stubWorkspaceSettingsServer();
    await openMembers();

    const list = await screen.findByRole("list", { name: "Members" });
    expect(screen.queryByRole("table")).toBeNull();
    const card = within(list).getAllByRole("listitem").find((item) => within(item).queryByText("Grace Hopper") !== null) as HTMLElement;
    expect(within(card).getByText("grace@example.org")).toBeTruthy();
    expect(within(card).getByRole("combobox", { name: "Role of Grace Hopper" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Actions for Grace Hopper" }));
      await Promise.resolve();
    });
    const sheet = await screen.findByRole("dialog", { name: "Actions for Grace Hopper" });
    await act(async () => {
      fireEvent.click(within(sheet).getByRole("button", { name: "Make admin" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(server.received("PATCH", `${MEMBERS_PATH}/${GRACE.accountId}`).map(({ body }) => body)).toEqual([{ role: "admin" }]);
    });
  }, SLOW_TEST_TIMEOUT_MS);
});
