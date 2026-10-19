import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp, type WebExtension } from "../src/index.ts";
import { WorkspaceAdminOnly } from "../src/shell/workspace-admin-only.tsx";
import { json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { WORKSPACE_PATH, stubWorkspaceSettingsServer, type Role } from "./workspace-settings-server.ts";

// /settings/workspace (doc 03 section 11.6). The failure scenarios are a rename that overwrites a workspace changed
// meanwhile, a refusal that is shown as a saved name, a member who can edit the name, a workspace that failed to load shown
// as an empty form, and an admin-only page that a member can open.

const SLOW_TEST_TIMEOUT_MS = 30_000;

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

async function open(path = "/settings/workspace", extensions: readonly WebExtension[] = []): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

async function openGeneral(): Promise<HTMLInputElement> {
  await open();
  await screen.findByRole("heading", { level: 1, name: "General" });
  return screen.findByRole<HTMLInputElement>("textbox", { name: "Name" });
}

async function click(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
}

describe("the settings navigation", () => {
  it.each<Role>(["owner", "admin", "member"])("lists General in the Workspace group for a %s, and marks it as the current page", async (role) => {
    stubWorkspaceSettingsServer({ role });
    await open("/settings/account");

    const nav = await screen.findByRole("navigation", { name: "Settings" });
    const group = await within(nav).findByRole("list", { name: "Workspace" });
    const general = within(group).getByRole("link", { name: "General" });
    expect(general.getAttribute("aria-current")).toBeNull();

    await act(async () => {
      fireEvent.click(general);
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/workspace");
    expect(within(screen.getByRole("navigation", { name: "Settings" })).getByRole("link", { name: "General" }).getAttribute("aria-current")).toBe("page");
  }, SLOW_TEST_TIMEOUT_MS);

  it("has no Workspace group while the account acts in no workspace", async () => {
    stubWorkspaceSettingsServer({ noWorkspace: true });
    await open("/settings/account");

    const nav = await screen.findByRole("navigation", { name: "Settings" });
    await within(nav).findByRole("link", { name: "Profile" });

    expect(within(nav).queryByRole("list", { name: "Workspace" })).toBeNull();
  });

  it("renders what an extension puts in the slot settings.workspace.nav", async () => {
    stubWorkspaceSettingsServer();
    await open("/settings/account", [{ id: "extra", slots: { "settings.workspace.nav": () => <a href="/extra">Billing</a> } }]);

    const nav = await screen.findByRole("navigation", { name: "Settings" });

    expect(within(nav).getByRole("link", { name: "Billing" })).toBeTruthy();
  });

  it("opens from Workspace settings in the workspace switcher", async () => {
    stubWorkspaceSettingsServer();
    await open("/");
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /^Workspace: / }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: "Workspace settings" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/workspace");
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the General page", () => {
  it("shows the name and the monogram, and saves a changed name against the version it read", async () => {
    const server = stubWorkspaceSettingsServer({ role: "admin", version: 3 });
    const input = await openGeneral();

    expect(input.value).toBe("Ada's Workspace");
    expect(input.readOnly).toBe(false);
    const monogram = (): string | null | undefined => document.querySelector("main [data-slot='avatar']")?.textContent;
    expect(monogram()).toBe("AW");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "  Bookmarks Club  " } });
    expect(monogram()).toBe("BC");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(false);
    await click("Save");

    expect(await screen.findByText("Workspace renamed")).toBeTruthy();
    expect(server.received("PATCH", WORKSPACE_PATH).map(({ ifMatch, body }) => [ifMatch, body])).toEqual([['"3"', { name: "Bookmarks Club" }]]);
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Bookmarks Club");
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
    // The switcher took the new name without a reload.
    await screen.findByRole("button", { name: "Workspace: Bookmarks Club" });
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps a second rename on the version the first one produced", async () => {
    const server = stubWorkspaceSettingsServer({ version: 3 });
    const input = await openGeneral();

    fireEvent.change(input, { target: { value: "One" } });
    await click("Save");
    await screen.findByText("Workspace renamed");
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("One");
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Two" } });
    await click("Save");

    await waitFor(() => {
      expect(server.received("PATCH", WORKSPACE_PATH).map(({ ifMatch }) => ifMatch)).toEqual(['"3"', '"4"']);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the name read-only to a member, with no Save", async () => {
    const server = stubWorkspaceSettingsServer({ role: "member" });
    const input = await openGeneral();

    expect(input.value).toBe("Ada's Workspace");
    expect(input.readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("Only admins and owners can rename the workspace.")).toBeTruthy();
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(server.received("PATCH", WORKSPACE_PATH)).toHaveLength(0);
  });

  it("refuses an empty and an over-long name before sending anything", async () => {
    const server = stubWorkspaceSettingsServer();
    const input = await openGeneral();

    fireEvent.change(input, { target: { value: "   " } });
    await click("Save");
    expect(await screen.findByText("Enter a name.")).toBeTruthy();

    fireEvent.change(input, { target: { value: "x".repeat(65) } });
    await click("Save");
    expect(await screen.findByText("Use at most 64 characters.")).toBeTruthy();
    expect(server.received("PATCH", WORKSPACE_PATH)).toHaveLength(0);
  });

  it("shows the field error of a name the server refused, and not a saved name", async () => {
    stubWorkspaceSettingsServer({
      patch: () =>
        json(
          { type: "u", title: "x", status: 422, code: "validation_failed", detail: "x", requestId: "req-422", errors: [{ path: "name", code: "too_small" }] },
          { status: 422, contentType: "application/problem+json" },
        ),
    });
    const input = await openGeneral();

    fireEvent.change(input, { target: { value: "New name" } });
    await click("Save");

    expect(await screen.findByText("Use a name with 1 to 64 characters.")).toBeTruthy();
    expect(screen.queryByText("Workspace renamed")).toBeNull();
  });

  it("shows a saving state while the rename is under way", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubWorkspaceSettingsServer({
      patch: async () => {
        await gate;
        return problem(503, "unavailable", "req-503");
      },
    });
    const input = await openGeneral();

    fireEvent.change(input, { target: { value: "New name" } });
    await click("Save");

    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).disabled).toBe(true);
    });
    expect(document.querySelector<HTMLButtonElement>("button[type='submit'][data-loading]")?.disabled).toBe(true);
    await act(async () => {
      release();
      await gate;
    });
    expect(await screen.findByText("The name could not be saved. Try again.")).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("New name");
  });

  it("says a rename was refused for lack of permission", async () => {
    stubWorkspaceSettingsServer({ patch: () => problem(403, "forbidden", "req-403") });
    const input = await openGeneral();

    fireEvent.change(input, { target: { value: "New name" } });
    await click("Save");

    expect(await screen.findByText("You are no longer allowed to change this workspace.")).toBeTruthy();
    expect(screen.queryByText("Workspace renamed")).toBeNull();
  });

  it("asks for a reload instead of overwriting a workspace that changed since it was read", async () => {
    const server = stubWorkspaceSettingsServer({ version: 3 });
    const input = await openGeneral();
    server.renameElsewhere("Renamed by Grace");

    fireEvent.change(input, { target: { value: "My name" } });
    await click("Save");

    expect(await screen.findByText("The workspace changed")).toBeTruthy();
    expect(screen.queryByText("Workspace renamed")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
    expect(server.received("PATCH", WORKSPACE_PATH)).toHaveLength(1);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("My name");

    await click("Reload");

    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Renamed by Grace");
    });
    expect(screen.queryByText("The workspace changed")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Mine, again" } });
    await click("Save");
    await screen.findByText("Workspace renamed");
    expect(server.received("PATCH", WORKSPACE_PATH).map(({ ifMatch }) => ifMatch)).toEqual(['"3"', '"4"']);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a loading skeleton, then says the workspace could not be loaded instead of an empty form, and loads it again on retry", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubWorkspaceSettingsServer({
      get: async (call) => {
        await gate;
        return call <= 3 ? problem(503, "unavailable", "req-503") : json({ id: "0192f3a0-cccc-7000-8000-000000000001", name: "Back", role: "owner", memberCount: 1, createdAt: "2026-09-01T08:00:00.000Z", version: 1 });
      },
    });
    await open();
    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    await act(async () => {
      release();
      await gate;
    });

    expect(await screen.findByText("The workspace could not be loaded", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    await click("Try again");

    expect((await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" })).value).toBe("Back");
    expect(server.received("GET", WORKSPACE_PATH).length).toBeGreaterThan(3);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("an admin-only workspace page", () => {
  const guarded: WebExtension = {
    id: "guarded",
    routes: [
      {
        path: "/guarded",
        component: () => (
          <WorkspaceAdminOnly>
            <h1>Admins only</h1>
          </WorkspaceAdminOnly>
        ),
      },
    ],
  };

  it.each<Role>(["owner", "admin"])("opens for a %s", async (role) => {
    stubWorkspaceSettingsServer({ role });
    await open("/guarded", [guarded]);

    expect(await screen.findByRole("heading", { level: 1, name: "Admins only" })).toBeTruthy();
  });

  it("shows the in-app 403 page to a member", async () => {
    stubWorkspaceSettingsServer({ role: "member" });
    await open("/guarded", [guarded]);

    expect(await screen.findByRole("heading", { name: "You don't have access" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Admins only" })).toBeNull();
  });

  it("says the role could not be read instead of opening the page", async () => {
    stubWorkspaceSettingsServer({ get: () => problem(503, "unavailable", "req-503") });
    await open("/guarded", [guarded]);

    expect(await screen.findByText("The workspace could not be loaded", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Admins only" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});
