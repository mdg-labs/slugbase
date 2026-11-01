import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entitlements } from "../src/entitlements/index.ts";
import type { WebExtension } from "../src/extensions/index.ts";
import { createWebApp } from "../src/index.ts";
import { SWITCH_WRITE_WAIT_MS } from "../src/shell/workspaces.ts";
import { ME_PATH, WORKSPACE_ID, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { OTHER_WORKSPACE_ID, SECOND_WORKSPACE_NAME, WORKSPACE_SETTINGS_PATH, stubWorkspaceSettingsServer, type Role } from "./workspace-settings-server.ts";

// /settings/workspace/ai (doc 03 section 11.10). The failure scenarios are a switch that shows "off" while the setting could not be
// loaded, a change that stays shown after the server refused it, controls on a server that has no AI port, controls for a workspace
// whose plan lacks ai.suggestions, a member who reaches the setting, a provider that is not named beside the switch, a save whose answer
// is lost, and a switch of workspace that shows or changes the setting of the other one.

const SLOW_TEST_TIMEOUT_MS = 30_000;
const LOADED_WAIT = { timeout: 10_000 } as const;
const ENTITLEMENTS_PATH = "/api/v1/entitlements";
const SWITCH = "Enable AI suggestions for this workspace";
const AI = { provider: "Example AI" } as const;

function entitlementsBody(aiSuggestions: boolean): Entitlements {
  return {
    entitlements: {
      "bookmarks.max": "unlimited",
      "seats.max": "unlimited",
      "workspaces.ownMax": "unlimited",
      "ai.suggestions": aiSuggestions,
      "sharing.members": true,
      "sharing.teams": true,
      "members.invite": true,
      "teams.manage": true,
      "audit.log": true,
    },
    usage: { "bookmarks.used": 0, "seats.used": 2, "workspaces.owned": 1 },
    upgradeAvailable: true,
  };
}

const UPGRADE: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <a href="/settings/billing">Upgrade plan</a> } };

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

async function open(path: string, extensions: readonly WebExtension[] = []): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

function server(options: Parameters<typeof stubWorkspaceSettingsServer>[0] = {}, aiSuggestions = true) {
  return stubWorkspaceSettingsServer({
    ai: AI,
    other: (request) => {
      if (new URL(request.url).pathname === ENTITLEMENTS_PATH) {
        return Promise.resolve(json(entitlementsBody(aiSuggestions)));
      }
      throw new Error(`unexpected call ${request.method} ${request.url}`);
    },
    ...options,
  });
}

async function openAi(): Promise<void> {
  await open("/settings/workspace/ai");
  await screen.findByRole("heading", { level: 1, name: "AI suggestions" }, LOADED_WAIT);
}

async function toggle(): Promise<void> {
  await act(async () => {
    fireEvent.click(await screen.findByRole("switch", { name: SWITCH }, LOADED_WAIT));
    await Promise.resolve();
  });
}

const FIRST_WORKSPACE_NAME = "Ada's Workspace";

/** Waits until the account has been read and no further read starts, so that a late answer cannot undo a switch made after it. */
async function settleAccountReads(stub: ReturnType<typeof server>): Promise<void> {
  let reads = -1;
  for (let round = 0; round < 20 && reads !== stub.received("GET", ME_PATH).length; round += 1) {
    reads = stub.received("GET", ME_PATH).length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  }
}

/**
 * Chooses the workspace in the sidebar's switcher. Opening the menu and the switch itself both start reads of the account; the test waits
 * for them, so that a late answer of one cannot undo the next switch. Reads that the test holds are not waited for.
 */
async function switchTo(stub: ReturnType<typeof server>, name: string): Promise<void> {
  const trigger = await screen.findByRole("button", { name: /^Workspace: / }, LOADED_WAIT);
  // The menu of an earlier switch may still be open, and the trigger would close it.
  if (trigger.getAttribute("aria-expanded") !== "true") {
    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });
  }
  const item = await screen.findByRole("menuitemradio", { name }, LOADED_WAIT);
  await settleAccountReads(stub);
  await act(async () => {
    fireEvent.click(item);
    await Promise.resolve();
  });
  await screen.findByRole("button", { name: `Workspace: ${name}` }, LOADED_WAIT);
  await settleAccountReads(stub);
}

describe("the navigation", () => {
  it.each<Role>(["owner", "admin"])("lists AI suggestions in the Workspace group for an %s and opens the page", async (role) => {
    server({ role });
    await open("/settings/account");

    const nav = await screen.findByRole("navigation", { name: "Settings" });
    const group = await within(nav).findByRole("list", { name: "Workspace" });
    await act(async () => {
      fireEvent.click(within(group).getByRole("link", { name: "AI suggestions" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: "AI suggestions" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/workspace/ai");
    expect(within(screen.getByRole("navigation", { name: "Settings" })).getByRole("link", { name: "AI suggestions" }).getAttribute("aria-current")).toBe("page");
  }, SLOW_TEST_TIMEOUT_MS);

  it("does not list it for a member", async () => {
    server({ role: "member" });
    await open("/settings/account");

    const nav = await screen.findByRole("navigation", { name: "Settings" });
    const group = await within(nav).findByRole("list", { name: "Workspace" });
    expect(within(group).getByRole("link", { name: "General" })).toBeTruthy();
    expect(within(group).queryByRole("link", { name: "AI suggestions" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a member who opens the address the 403 page, without asking for the setting", async () => {
    const stub = server({ role: "member" });
    await open("/settings/workspace/ai");

    expect(await screen.findByRole("heading", { name: "You don't have access" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(stub.received("GET", WORKSPACE_SETTINGS_PATH)).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the AI suggestions page", () => {
  it("shows the switch as the server stores it, and names the provider and what is sent", async () => {
    server({ aiEnabled: true });
    await openAi();

    const toggleSwitch = await screen.findByRole("switch", { name: SWITCH });
    expect(toggleSwitch.getAttribute("aria-checked")).toBe("true");
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("Example AI");
    expect(note.textContent).toContain("URL");
    expect(note.textContent).toContain("public metadata");
    expect(note.textContent).toContain("tag names");
    expect(screen.queryByRole("textbox")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a workspace that turned it off as off", async () => {
    server({ aiEnabled: false });
    await openAi();

    expect((await screen.findByRole("switch", { name: SWITCH })).getAttribute("aria-checked")).toBe("false");
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a loading skeleton and no switch while the setting is read", async () => {
    let release: (response: Response) => void = () => undefined;
    server({ settingsGet: () => new Promise<Response>((resolve) => (release = resolve)) });
    await openAi();

    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();

    await act(async () => {
      release(json({ aiEnabled: false }));
      await Promise.resolve();
    });
    expect((await screen.findByRole("switch", { name: SWITCH })).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows an error with a retry, and no switch, when the setting cannot be read; the retry loads it", async () => {
    let failing = true;
    server({ settingsGet: () => (failing ? problem(500, "internal_error", "req-500") : json({ aiEnabled: false })) });
    await openAi();

    expect(await screen.findByText("The AI setting could not be loaded", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();

    failing = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await Promise.resolve();
    });
    expect((await screen.findByRole("switch", { name: SWITCH })).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("The AI setting could not be loaded")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the skeleton while the account cannot be read, then an error with a retry; the retry loads the page", async () => {
    let failing = true;
    // The first read is the route's own, which does not retry; the page asks again and retries before it gives up.
    const stub = server({ meGet: () => (failing ? problem(500, "internal_error", "req-me") : undefined) });
    await open("/settings/workspace/ai");
    await screen.findByRole("heading", { level: 1, name: "AI suggestions" }, LOADED_WAIT);

    expect((await within(screen.getByRole("main")).findAllByRole("status", { name: "Loading" })).length).toBeGreaterThan(0);
    expect(screen.queryByText("The AI setting could not be loaded")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();

    expect(await screen.findByText("The AI setting could not be loaded", undefined, { timeout: 20_000 })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(stub.received("GET", ME_PATH).length).toBeGreaterThan(2);

    failing = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await Promise.resolve();
    });
    expect((await screen.findByRole("switch", { name: SWITCH }, LOADED_WAIT)).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("The AI setting could not be loaded")).toBeNull();
  }, 60_000);

  it("leaves the skeleton for the page of an account without a workspace when the account stops acting in one while the page is open", async () => {
    const stub = server();
    await openAi();
    expect(await screen.findByRole("switch", { name: SWITCH }, LOADED_WAIT)).toBeTruthy();

    stub.leaveElsewhere();
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/no-workspace");
    }, LOADED_WAIT);
    expect(await screen.findByRole("heading", { level: 1, name: "Waiting for an invitation" }, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("saves the one field that changed and shows the answer", async () => {
    const stub = server();
    await openAi();

    await toggle();

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("false");
    });
    expect(stub.received("PATCH", WORKSPACE_SETTINGS_PATH).map(({ body }) => body)).toEqual([{ aiEnabled: false }]);

    await toggle();
    await waitFor(() => {
      expect(stub.received("PATCH", WORKSPACE_SETTINGS_PATH).map(({ body }) => body)).toEqual([{ aiEnabled: false }, { aiEnabled: true }]);
    });
    expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("true");
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the change at once, and takes it back with an error toast when the server refuses it", async () => {
    let release: (response: Response) => void = () => undefined;
    server({ settingsPatch: () => new Promise<Response>((resolve) => (release = resolve)) });
    await openAi();

    await toggle();
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("false");
    });

    await act(async () => {
      release(problem(500, "internal_error", "req-save"));
      await Promise.resolve();
    });
    expect((await screen.findAllByRole("alert")).map((alert) => alert.textContent).join(" ")).toContain("The change was not saved");
    expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("true");
  }, SLOW_TEST_TIMEOUT_MS);

  it("takes the change back when the server cannot be reached", async () => {
    server({ settingsPatch: () => Promise.reject(new TypeError("Failed to fetch")) });
    await openAi();

    await toggle();

    expect((await screen.findAllByRole("alert")).map((alert) => alert.textContent).join(" ")).toContain("The change was not saved");
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("true");
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("goes back to what the server held when the role was withdrawn meanwhile (403)", async () => {
    server({ settingsPatch: () => problem(403, "forbidden", "req-403") });
    await openAi();

    await toggle();

    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("true");
    });
    expect((await screen.findAllByRole("alert")).map((alert) => alert.textContent).join(" ")).toContain("The change was not saved");
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("a save that fails", () => {
  it("reads the setting again when the change was applied but the answer was lost", async () => {
    const stub = server({
      settingsPatch: () => {
        stub.setAiEnabled(WORKSPACE_ID, false);
        return Promise.reject(new TypeError("Failed to fetch"));
      },
    });
    await openAi();

    await toggle();

    expect((await screen.findAllByRole("alert")).map((alert) => alert.textContent).join(" ")).toContain("The change was not saved");
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("false");
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("closes the page when the 403 means the role was withdrawn", async () => {
    const stub = server({
      settingsPatch: () => {
        stub.setRole("member");
        return problem(403, "forbidden", "req-403");
      },
    });
    await openAi();

    await toggle();

    expect(await screen.findByRole("heading", { name: "You don't have access" }, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    // The account is read again too, so the navigation stops offering the page.
    const nav = screen.getByRole("navigation", { name: "Settings" });
    await waitFor(() => {
      expect(within(nav).queryByRole("link", { name: "AI suggestions" })).toBeNull();
    }, LOADED_WAIT);
  }, SLOW_TEST_TIMEOUT_MS);

  it("sends one save at a time: the switch is off-limits while it is out", async () => {
    let release: (response: Response) => void = () => undefined;
    const stub = server({ settingsPatch: () => new Promise<Response>((resolve) => (release = resolve)) });
    await openAi();

    await toggle();
    const toggleSwitch = await screen.findByRole("switch", { name: SWITCH }, LOADED_WAIT);
    await waitFor(() => {
      expect(toggleSwitch.getAttribute("aria-checked")).toBe("false");
    }, LOADED_WAIT);
    await act(async () => {
      fireEvent.click(toggleSwitch);
      await Promise.resolve();
    });

    expect(toggleSwitch.hasAttribute("disabled") || toggleSwitch.getAttribute("aria-disabled") === "true").toBe(true);
    expect(stub.received("PATCH", WORKSPACE_SETTINGS_PATH)).toHaveLength(1);
    expect(toggleSwitch.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      release(json({ aiEnabled: false }));
      await Promise.resolve();
    });
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("a switch of workspace on the page", () => {
  it("shows each workspace's own setting, and a skeleton while the other one is read", async () => {
    const held = new Map<string, (response: Response) => void>();
    const stored = new Map([[WORKSPACE_ID, true], [OTHER_WORKSPACE_ID, false]]);
    let holding = false;
    const workspaceReads: ((response: Response) => void)[] = [];
    // The workspace read is held too: the page asks for the settings only once the new workspace's role is known.
    const stub = server({
      second: { aiEnabled: false },
      get: () => (holding ? new Promise<Response>((resolve) => workspaceReads.push(resolve)) : undefined),
      settingsGet: (_call, workspaceId) =>
        holding
          ? new Promise<Response>((resolve) => {
              held.set(workspaceId, resolve);
            })
          : json({ aiEnabled: stored.get(workspaceId) }),
    });
    await openAi();
    expect((await screen.findByRole("switch", { name: SWITCH })).getAttribute("aria-checked")).toBe("true");

    holding = true;
    await switchTo(stub, SECOND_WORKSPACE_NAME);

    expect(await screen.findByRole("status", { name: "Loading" }, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    await act(async () => {
      for (const release of workspaceReads) {
        release(json({ id: OTHER_WORKSPACE_ID, name: SECOND_WORKSPACE_NAME, role: "owner", memberCount: 2, createdAt: "2026-09-01T08:00:00.000Z", version: 3 }));
      }
      await Promise.resolve();
    });
    // The role is known, and the setting of the new workspace is still on its way.
    expect(await screen.findByRole("status", { name: "Loading" }, LOADED_WAIT)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    await act(async () => {
      held.get(OTHER_WORKSPACE_ID)?.(json({ aiEnabled: false }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("false");
    }, LOADED_WAIT);

    held.clear();
    workspaceReads.length = 0;
    await switchTo(stub, FIRST_WORKSPACE_NAME);

    // The cached document is the other workspace's, so the page waits for this workspace's own before it shows anything.
    expect(screen.queryByRole("switch")).toBeNull();
    await waitFor(() => {
      expect(workspaceReads.length).toBeGreaterThan(0);
    }, LOADED_WAIT);
    await act(async () => {
      for (const release of workspaceReads) {
        release(json({ id: WORKSPACE_ID, name: FIRST_WORKSPACE_NAME, role: "owner", memberCount: 2, createdAt: "2026-09-01T08:00:00.000Z", version: 3 }));
      }
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(held.has(WORKSPACE_ID)).toBe(true);
    }, LOADED_WAIT);
    expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      held.get(WORKSPACE_ID)?.(json({ aiEnabled: true }));
      await Promise.resolve();
    });
    expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("true");
  }, SLOW_TEST_TIMEOUT_MS);

  it("takes a refused save back in the workspace it started in, when the session moved meanwhile", async () => {
    let release: (response: Response) => void = () => undefined;
    let holding = false;
    const held = new Map<string, (response: Response) => void>();
    const stub = server({
      aiEnabled: true,
      second: { aiEnabled: false },
      settingsPatch: () => new Promise<Response>((resolve) => (release = resolve)),
      settingsGet: (_call, workspaceId) =>
        holding
          ? new Promise<Response>((resolve) => {
              held.set(workspaceId, resolve);
            })
          : json({ aiEnabled: workspaceId === WORKSPACE_ID }),
    });
    await openAi();

    await toggle();
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("false");
    }, LOADED_WAIT);
    // A save that has not answered for longer than SWITCH_WRITE_WAIT_MS is taken as stuck and no longer holds the switch back.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + SWITCH_WRITE_WAIT_MS + 1000);
    await switchTo(stub, SECOND_WORKSPACE_NAME);
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("false");
    }, LOADED_WAIT);

    holding = true;
    await act(async () => {
      release(problem(500, "internal_error", "req-save"));
      await Promise.resolve();
    });
    expect((await screen.findAllByRole("alert", undefined, LOADED_WAIT)).map((alert) => alert.textContent).join(" ")).toContain("The change was not saved");

    // The second workspace keeps its own value, and the first one is back to what it held before the change.
    expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("false");
    held.clear();
    await switchTo(stub, FIRST_WORKSPACE_NAME);
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: SWITCH }).getAttribute("aria-checked")).toBe("true");
    }, LOADED_WAIT);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("a server without an AI port", () => {
  it("says it is not available, with no switch, and does not ask for the setting", async () => {
    const stub = stubWorkspaceSettingsServer({
      other: (request) => Promise.resolve(new URL(request.url).pathname === ENTITLEMENTS_PATH ? json(entitlementsBody(true)) : problem(500, "x", "req-x")),
    });
    await openAi();

    expect(await screen.findByText("Not available on this server")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("note", { name: /Example AI/ })).toBeNull();
    expect(stub.received("GET", WORKSPACE_SETTINGS_PATH)).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the entitlement ai.suggestions", () => {
  it("replaces the setting with the upgrade slot where the workspace lacks it", async () => {
    const stub = server({}, false);
    await open("/settings/workspace/ai", [UPGRADE]);
    await screen.findByRole("heading", { level: 1, name: "AI suggestions" });

    expect(await screen.findByText("Upgrade plan")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("switch", { name: SWITCH })).toBeNull();
    });
    expect(stub.received("PATCH", WORKSPACE_SETTINGS_PATH)).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the setting where the workspace has it", async () => {
    server({}, true);
    await open("/settings/workspace/ai", [UPGRADE]);

    expect(await screen.findByRole("switch", { name: SWITCH })).toBeTruthy();
    expect(screen.queryByText("Upgrade plan")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});
