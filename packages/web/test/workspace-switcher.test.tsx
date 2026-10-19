import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import type { WebExtension } from "../src/index.ts";
import { ACTIVE_WORKSPACE_PATH, WORKSPACES_PATH, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { HOME, NEW_ID, TEAM, stubWorkspaceServer } from "./workspace-server.ts";

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function mountApp(extensions: readonly WebExtension[] = []): Promise<void> {
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

function trigger(name: string | RegExp = /^Workspace: /): Promise<HTMLElement> {
  return screen.findByRole("button", { name });
}

async function openMenu(name?: string | RegExp): Promise<HTMLElement> {
  const button = await trigger(name);
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
  return screen.findByRole("menu");
}

async function choose(role: "menuitem" | "menuitemradio", name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(await screen.findByRole(role, { name }));
    await Promise.resolve();
  });
}

async function fillName(name: string): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: "New workspace" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: name } });
}

async function submitCreate(): Promise<void> {
  const dialog = screen.getByRole("dialog", { name: "New workspace" });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await Promise.resolve();
  });
}

describe("the workspace switcher in the sidebar header", () => {
  it("shows the active workspace's monogram and name, and a menu of the account's workspaces with a check on the active one", async () => {
    stubWorkspaceServer();
    await mountApp();

    const button = await trigger("Workspace: Home");
    const header = button.closest("[data-slot='sidebar-header']");
    expect(header).not.toBeNull();
    expect(within(button).getByText("Home")).toBeTruthy();
    expect(button.querySelector("[data-slot='avatar'][aria-hidden='true']")?.textContent).toBe("H");

    const menu = await openMenu();

    expect(within(menu).getByText("Workspaces")).toBeTruthy();
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([
      ["Home", "true"],
      ["Team", "false"],
    ]);
  });

  it("offers neither New workspace nor Workspace settings where creation is off and the settings page does not exist yet", async () => {
    stubWorkspaceServer({ canCreate: false });
    await mountApp();

    const menu = await openMenu();

    await within(menu).findByRole("menuitemradio", { name: "Team" });
    expect(within(menu).queryByRole("menuitem")).toBeNull();
  });

  it("offers New workspace only when the list says the account can create one", async () => {
    stubWorkspaceServer({ canCreate: true });
    await mountApp();

    const menu = await openMenu();

    expect(await within(menu).findByRole("menuitem", { name: "New workspace" })).toBeTruthy();
  });

  it("offers Workspace settings once the app has that page, and goes there", async () => {
    stubWorkspaceServer();
    await mountApp([{ id: "settings", routes: [{ path: "/settings/workspace", component: () => <h1>Workspace page</h1> }] }]);

    await openMenu();
    await choose("menuitem", "Workspace settings");

    expect(await screen.findByRole("heading", { name: "Workspace page" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/workspace");
  });

  it("says there are no other workspaces when the active one is the only one", async () => {
    stubWorkspaceServer({ workspaces: [HOME] });
    await mountApp();

    const menu = await openMenu();

    expect(await within(menu).findByText("No other workspaces yet.")).toBeTruthy();
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(1);
  });

  it("renders the slot sidebar.workspacePlan under the name, and nothing without an extension", async () => {
    stubWorkspaceServer();
    await mountApp([{ id: "plan", slots: { "sidebar.workspacePlan": () => <span>Team plan</span> } }]);

    const button = await trigger();

    const plan = screen.getByText("Team plan");
    expect(button.contains(plan)).toBe(false);
    expect(plan.closest("[data-slot='sidebar-header']")).not.toBeNull();
  });

  it("leaves no plan element in the header when no extension fills the slot", async () => {
    stubWorkspaceServer();
    await mountApp();

    const button = await trigger();

    expect(button.closest("[data-slot='sidebar-menu-item']")?.children).toHaveLength(1);
  });
});

describe("choosing a workspace", () => {
  it("calls PUT /session/active-workspace, reloads the data and shows the chosen workspace as active", async () => {
    const server = stubWorkspaceServer();
    await mountApp();
    await trigger("Workspace: Home");
    const listReads = (): number => server.calls("GET", WORKSPACES_PATH).length;
    const before = listReads();

    await openMenu();
    await choose("menuitemradio", "Team");

    expect(await trigger("Workspace: Team")).toBeTruthy();
    expect(server.calls("PUT", ACTIVE_WORKSPACE_PATH).map((call) => call.body)).toEqual([{ workspaceId: TEAM.id }]);
    await waitFor(() => {
      expect(listReads()).toBeGreaterThan(before);
    });
    const menu = await openMenu();
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  });

  it("keeps the workspace active and raises an error toast when the server refuses the switch", async () => {
    const server = stubWorkspaceServer({ put: () => Promise.resolve(problem(503, "unavailable", "req-put")) });
    await mountApp();

    await openMenu();
    await choose("menuitemradio", "Team");

    expect((await screen.findAllByText("The workspace was not switched")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("You are still in the same workspace. Try again.").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Workspace: Home" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Workspace: Team" })).toBeNull();
    expect(server.calls("PUT", ACTIVE_WORKSPACE_PATH)).toHaveLength(1);
  });

  it("keeps the workspace active when the request does not reach the server", async () => {
    stubWorkspaceServer({ put: () => Promise.reject(new TypeError("fetch failed")) });
    await mountApp();

    await openMenu();
    await choose("menuitemradio", "Team");

    expect((await screen.findAllByText("The workspace was not switched")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Workspace: Home" })).toBeTruthy();
  });

  it("says the account is no longer a member when the server does not know the membership, and reloads the list", async () => {
    const server = stubWorkspaceServer({ put: () => Promise.resolve(problem(404, "not_found", "req-put")) });
    await mountApp();
    await trigger();
    const before = server.calls("GET", WORKSPACES_PATH).length;

    await openMenu();
    await choose("menuitemradio", "Team");

    expect((await screen.findAllByText("You are no longer a member of that workspace.")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Workspace: Home" })).toBeTruthy();
    await waitFor(() => {
      expect(server.calls("GET", WORKSPACES_PATH).length).toBeGreaterThan(before);
    });
  });

  it("does nothing when the active workspace is chosen again", async () => {
    const server = stubWorkspaceServer();
    await mountApp();

    await openMenu();
    await choose("menuitemradio", "Home");

    expect(server.calls("PUT", ACTIVE_WORKSPACE_PATH)).toHaveLength(0);
  });
});

describe("the states of the switcher", () => {
  it("shows a skeleton in the menu while the list is on its way", async () => {
    stubWorkspaceServer({ list: () => new Promise<Response>(() => undefined) });
    await mountApp();

    const menu = await openMenu();

    expect(within(menu).getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitemradio")).toBeNull();
  });

  it("says the list could not be loaded, never shows it as empty, and loads it again on request", async () => {
    let failing = true;
    const server = stubWorkspaceServer({
      list: () =>
        Promise.resolve(
          failing
            ? problem(400, "bad_request", "req-list")
            : json({ items: [{ id: HOME.id, name: "Home", role: "owner", memberCount: 1 }], canCreate: false }),
        ),
    });
    await mountApp();

    const menu = await openMenu();

    expect(await within(menu).findByText("Your workspaces could not be loaded.")).toBeTruthy();
    expect(within(menu).queryByText("No other workspaces yet.")).toBeNull();
    expect(within(menu).queryByRole("menuitemradio")).toBeNull();
    failing = false;
    await choose("menuitem", "Try again");
    await waitFor(() => {
      expect(server.calls("GET", WORKSPACES_PATH)).toHaveLength(2);
    });
    expect(await screen.findByRole("menuitemradio", { name: "Home" })).toBeTruthy();
  });

  it("shows a skeleton in place of the name while the account is asked for again", async () => {
    let asked = 0;
    stubWorkspaceServer({
      me: () => {
        asked += 1;
        return asked === 1 ? Promise.resolve(problem(400, "bad_request", "req-me")) : new Promise<Response>(() => undefined);
      },
    });
    await mountApp();

    const header = (await screen.findByRole("main")).ownerDocument.querySelector<HTMLElement>("[data-slot='sidebar-header']");
    expect(await within(header ?? document.body).findByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Workspace: / })).toBeNull();
  });

  it("names the switcher as unavailable when the account cannot be loaded", async () => {
    stubWorkspaceServer({ me: () => Promise.resolve(problem(400, "bad_request", "req-me")) });
    await mountApp();

    expect(await screen.findByRole("button", { name: "Workspace: Workspace unavailable" })).toBeTruthy();
  });

  it("works at phone width, in the drawer", async () => {
    stubMatchMedia(true);
    window.innerWidth = 375;
    const server = stubWorkspaceServer();
    await mountApp();

    fireEvent.click(await screen.findByRole("button", { name: "Toggle sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await act(async () => {
      fireEvent.click(await within(drawer).findByRole("button", { name: "Workspace: Home" }));
      await Promise.resolve();
    });
    await choose("menuitemradio", "Team");

    await waitFor(() => {
      expect(server.calls("PUT", ACTIVE_WORKSPACE_PATH)).toHaveLength(1);
    });
  });

  it("opens and chooses by keyboard", async () => {
    const server = stubWorkspaceServer();
    await mountApp();

    const button = await trigger();
    button.focus();
    await act(async () => {
      fireEvent.keyDown(button, { key: "ArrowDown" });
      await Promise.resolve();
    });
    const team = await screen.findByRole("menuitemradio", { name: "Team" });
    await act(async () => {
      team.focus();
      fireEvent.keyDown(team, { key: "Enter" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(server.calls("PUT", ACTIVE_WORKSPACE_PATH).map((call) => call.body)).toEqual([{ workspaceId: TEAM.id }]);
    });
  });

  it("is written in German for a German browser", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubWorkspaceServer({ canCreate: true });
    await mountApp();

    const menu = await openMenu("Workspace: Home");

    expect(within(menu).getByText("Workspaces")).toBeTruthy();
    expect(await within(menu).findByRole("menuitem", { name: "Neuer Workspace" })).toBeTruthy();
  });
});

describe("the accessibility of the switcher", () => {
  it("has no axe violations closed, with the menu open, and with the create dialog open", async () => {
    stubWorkspaceServer({ canCreate: true });
    await mountApp();
    const options = { rules: { region: { enabled: false } } };
    await trigger();
    expect((await axe(document.body, options)).violations.map(({ id }) => id)).toEqual([]);

    await openMenu();
    await screen.findByRole("menuitem", { name: "New workspace" });
    expect((await axe(document.body, options)).violations.map(({ id }) => id)).toEqual([]);

    await choose("menuitem", "New workspace");
    await screen.findByRole("dialog", { name: "New workspace" });
    expect((await axe(document.body, options)).violations.map(({ id }) => id)).toEqual([]);
  });
});

describe("creating a workspace from the switcher", () => {
  it("creates it with POST /workspaces, then switches to it", async () => {
    const server = stubWorkspaceServer({ canCreate: true });
    await mountApp();

    await openMenu();
    await choose("menuitem", "New workspace");
    await fillName("  Side project ");
    await submitCreate();

    expect(await trigger("Workspace: Side project")).toBeTruthy();
    expect(server.calls("POST", WORKSPACES_PATH).map((call) => call.body)).toEqual([{ name: "Side project" }]);
    expect(server.calls("PUT", ACTIVE_WORKSPACE_PATH).map((call) => call.body)).toEqual([{ workspaceId: NEW_ID }]);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New workspace" })).toBeNull();
    });
  });

  it("asks for a name and sends nothing while it is blank", async () => {
    const server = stubWorkspaceServer({ canCreate: true });
    await mountApp();

    await openMenu();
    await choose("menuitem", "New workspace");
    await fillName("   ");
    await submitCreate();

    expect(await screen.findByText("Enter a name.")).toBeTruthy();
    expect(server.calls("POST", WORKSPACES_PATH)).toHaveLength(0);
  });

  it("says what is wrong and does not switch when the creation fails", async () => {
    const server = stubWorkspaceServer({ canCreate: true, post: () => Promise.resolve(problem(403, "email_unverified", "req-post")) });
    await mountApp();

    await openMenu();
    await choose("menuitem", "New workspace");
    await fillName("Side project");
    await submitCreate();

    expect(await screen.findByText("Verify your email address to create a workspace.")).toBeTruthy();
    expect(server.calls("PUT", ACTIVE_WORKSPACE_PATH)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Workspace: Home", hidden: true })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "New workspace" })).toBeTruthy();
  });

  it("shows a refused name in the field", async () => {
    stubWorkspaceServer({ canCreate: true, post: () => Promise.resolve(problem(422, "validation_failed", "req-post")) });
    await mountApp();

    await openMenu();
    await choose("menuitem", "New workspace");
    await fillName("x");
    await submitCreate();

    expect(await screen.findByText("Use a name of 1 to 64 characters.")).toBeTruthy();
  });

  it("says the workspace exists and offers the switch again when the creation went through and the switch did not", async () => {
    const server = stubWorkspaceServer({
      canCreate: true,
      put: (request, count) => {
        if (count === 1) {
          return Promise.resolve(problem(503, "unavailable", "req-put"));
        }
        return request.clone().json().then((body: { workspaceId: string }) => {
          server.activate(body.workspaceId);
          return new Response(null, { status: 204 });
        });
      },
    });
    await mountApp();

    await openMenu();
    await choose("menuitem", "New workspace");
    await fillName("Side project");
    await submitCreate();

    expect(await screen.findByText("The new workspace was not opened")).toBeTruthy();
    expect(screen.getByText(/“Side project” was created\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Workspace: Home", hidden: true })).toBeTruthy();
    expect(server.calls("POST", WORKSPACES_PATH)).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await Promise.resolve();
    });

    expect(await trigger("Workspace: Side project")).toBeTruthy();
    expect(server.calls("POST", WORKSPACES_PATH)).toHaveLength(1);
    expect(server.calls("PUT", ACTIVE_WORKSPACE_PATH).map((call) => call.body)).toEqual([{ workspaceId: NEW_ID }, { workspaceId: NEW_ID }]);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New workspace" })).toBeNull();
    });
  });

  it("lists the workspace that was created even when it was not opened", async () => {
    stubWorkspaceServer({ canCreate: true, put: () => Promise.resolve(problem(503, "unavailable", "req-put")) });
    await mountApp();

    await openMenu();
    await choose("menuitem", "New workspace");
    await fillName("Side project");
    await submitCreate();
    await screen.findByText("The new workspace was not opened");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      await Promise.resolve();
    });

    const menu = await openMenu();

    expect(await within(menu).findByRole("menuitemradio", { name: "Side project" })).toBeTruthy();
    expect(within(menu).getByRole("menuitemradio", { name: "Home" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("an account that acts in no workspace", () => {
  it("is sent from a workspace page to /no-workspace", async () => {
    stubWorkspaceServer({ workspaces: [], active: null });
    await mountApp();

    expect(await screen.findByRole("heading", { level: 1, name: "Waiting for an invitation" })).toBeTruthy();
    expect(window.location.pathname).toBe("/no-workspace");
  });

  it("can still open its account settings, where the switcher names no workspace", async () => {
    stubWorkspaceServer({ workspaces: [], active: null });
    window.history.replaceState(null, "", "/settings/account");
    await mountApp();

    expect(await screen.findByRole("button", { name: "Workspace: No workspace" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/account");
  });
});
