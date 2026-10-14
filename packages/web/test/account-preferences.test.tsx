import type { ComponentTypes } from "@slugbase/contracts";
import { ACCENT_PRESETS } from "@slugbase/contracts";
import { ACCENTS, useShortcut } from "@slugbase/ui";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp, type WebExtension } from "../src/index.ts";
import { ACCOUNT_BODY, CONFIG_BODY, ME_PATH, SESSION_PATH, json, problem, renderApp, signedIn, stubBrowserApis } from "./support.tsx";

// /settings/account/preferences (doc 03 section 11.4) and the preferences the app applies from the account it
// loads at start. The failure scenarios are a theme or accent that shows but is not kept, a change reported as
// saved when the server refused it, a preference that only applies after a visit to the settings, and single-key
// shortcuts that still fire after they were turned off.

type Transport = (request: Request) => Promise<Response>;
type Account = ComponentTypes["schemas"]["Account"];

const ACCOUNT: Account = ACCOUNT_BODY;

interface Server {
  readonly fetch: ReturnType<typeof vi.fn<Transport>>;
  /** The JSON bodies the account update received. */
  readonly patches: () => Promise<unknown[]>;
  readonly account: () => Account;
}

function me(account: Account): ComponentTypes["schemas"]["Me"] {
  return { account, memberships: [], activeWorkspaceId: null };
}

/** A server with a signed-in account that applies each update to the account it holds, as the real one does. */
function stubServer({ account: initial = ACCOUNT, ai = false, patch }: { account?: Account; ai?: boolean; patch?: Transport } = {}): Server {
  let account = initial;
  const received: Request[] = [];
  const fetch = vi.fn<Transport>(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return json({ ...CONFIG_BODY, features: { ai, mail: false } });
    }
    if (pathname !== ME_PATH) {
      return signedIn(request);
    }
    if (request.method === "GET") {
      return json(me(account));
    }
    received.push(request.clone());
    if (patch !== undefined) {
      return patch(request);
    }
    const changes = (await request.json()) as Partial<Account>;
    account = { ...account, ...changes };
    return json(account);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, patches: () => Promise.all(received.map((request) => request.json() as Promise<unknown>)), account: () => account };
}

function stubMatchMedia(systemDark: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: systemDark && query.includes("prefers-color-scheme: dark"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

async function openApp(path: string, extensions: readonly WebExtension[] = []): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

async function openPreferences(extensions: readonly WebExtension[] = []): Promise<void> {
  await openApp("/settings/account/preferences", extensions);
  await screen.findByRole("heading", { level: 1, name: "Preferences" });
}

async function choose(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("radio", { name }));
    await Promise.resolve();
  });
}

async function toggle(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name }));
    await Promise.resolve();
  });
}

function rootClasses(): string[] {
  return [...document.documentElement.classList];
}

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

describe("the preferences page", () => {
  it("shows the theme, the accent swatches, the default view and the single-key shortcuts switch, in the settings navigation", async () => {
    stubServer();
    await openPreferences();

    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("link", { name: "Preferences" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByRole("radio", { name: /^(Dark|Light|System)$/ })).toHaveLength(3);
    const swatches = within(screen.getByRole("radiogroup", { name: "Accent colour" })).getAllByRole("radio");
    expect(swatches.map((swatch) => swatch.getAttribute("data-accent"))).toEqual([...ACCENTS]);
    expect(screen.getByRole("radio", { name: "Periwinkle" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Grid" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Single-key shortcuts" }).getAttribute("aria-checked")).toBe("true");
  });

  it("names the accent presets of the contract", () => {
    expect([...ACCENTS]).toEqual([...ACCENT_PRESETS]);
  });

  it("shows no AI opt-out and no restore of the Getting started checklist while the server has no AI", async () => {
    stubServer({ ai: false });
    await openPreferences();

    expect(screen.queryByRole("switch", { name: /AI/ })).toBeNull();
    expect(screen.queryByText(/Getting started/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Getting started|restore/i })).toBeNull();
  });

  it("shows the AI opt-out where the server reports an AI port, and saves it", async () => {
    const server = stubServer({ ai: true });
    await openPreferences();

    await toggle("Don't use AI suggestions for me");

    await waitFor(async () => {
      expect(await server.patches()).toEqual([{ aiOptOut: true }]);
    });
    expect(screen.getByRole("switch", { name: "Don't use AI suggestions for me" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/Getting started/i)).toBeNull();
  });

  it("is reachable from the settings navigation of the profile page", async () => {
    stubServer();
    await openApp("/settings/account");
    await screen.findByRole("heading", { level: 1, name: "Profile" });

    const nav = screen.getByRole("navigation", { name: "Settings" });
    await act(async () => {
      fireEvent.click(within(nav).getByRole("link", { name: "Preferences" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Preferences" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/account/preferences");
  });
});

describe("theme and accent", () => {
  it("apply at once and are sent as the one field that changed, with the saving state and then the saved state", async () => {
    let release: (response: Response) => void = () => undefined;
    const server = stubServer({
      patch: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    await openPreferences();

    await choose("Dark");

    expect(rootClasses()).toEqual(["dark"]);
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Saving…");
    expect(await server.patches()).toEqual([{ theme: "dark" }]);

    await act(async () => {
      release(json({ ...ACCOUNT, theme: "dark" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("All changes saved");
    });
    expect(rootClasses()).toEqual(["dark"]);
  });

  it("apply the accent as data-accent and send it", async () => {
    const server = stubServer();
    await openPreferences();

    await choose("Teal");

    expect(document.documentElement.getAttribute("data-accent")).toBe("teal");
    await waitFor(async () => {
      expect(await server.patches()).toEqual([{ accent: "teal" }]);
    });
    expect(server.account().accent).toBe("teal");
  });

  it("follow the operating system for the system choice", async () => {
    stubMatchMedia(true);
    const server = stubServer({ account: { ...ACCOUNT, theme: "light" } });
    await openPreferences();
    expect(rootClasses()).toEqual(["light"]);

    await choose("System");

    expect(rootClasses()).toEqual(["dark"]);
    await waitFor(async () => {
      expect(await server.patches()).toEqual([{ theme: "system" }]);
    });
  });

  it("are read back from the account after a reload, whatever the browser had stored", async () => {
    const server = stubServer();
    await openPreferences();
    await choose("Dark");
    await choose("Rose");
    await waitFor(() => {
      expect(server.account()).toMatchObject({ theme: "dark", accent: "rose" });
    });

    // A new page load: the browser remembers something else, the account decides.
    cleanup();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("data-accent");
    window.localStorage.setItem("slugbase-theme", "light");
    window.localStorage.setItem("slugbase-accent", "teal");
    await openApp("/");

    await screen.findByRole("heading", { level: 1 });
    expect(rootClasses()).toEqual(["dark"]);
    expect(document.documentElement.getAttribute("data-accent")).toBe("rose");
  });

  it("applies the account's theme, accent and language on the first page that opens, without a visit to the settings", async () => {
    stubServer({ account: { ...ACCOUNT, theme: "dark", accent: "amber", locale: "de" } });
    await openApp("/");

    expect(await screen.findByRole("heading", { level: 1, name: /^Willkommen bei / })).toBeTruthy();
    expect(rootClasses()).toEqual(["dark"]);
    expect(document.documentElement.getAttribute("data-accent")).toBe("amber");
    expect(document.documentElement.lang).toBe("de");
  });

  it("are taken back, with a field error and the error toast, when the server refuses the change", async () => {
    const server = stubServer({
      patch: () => Promise.resolve(problem(422, "validation_failed", "req-patch")),
    });
    await openPreferences();

    await choose("Dark");

    expect(await screen.findByText("This change was not saved.")).toBeTruthy();
    expect((await screen.findAllByRole("alert")).map((alert) => alert.textContent).join(" ")).toContain("The change was not saved");
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
    expect(rootClasses()).toEqual(["light"]);
    expect(screen.getByRole("radiogroup", { name: "Theme" }).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("");
    expect(await server.patches()).toEqual([{ theme: "dark" }]);
  });

  it("are taken back when the server cannot be reached, and the error goes when the next change is made", async () => {
    let failing = true;
    stubServer({
      patch: async (request) => {
        if (failing) {
          throw new TypeError("fetch failed");
        }
        return json({ ...ACCOUNT, ...((await request.json()) as object) });
      },
    });
    await openPreferences();

    await choose("Teal");
    expect(await screen.findByText("This change was not saved.")).toBeTruthy();
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
    expect(screen.getByRole("radio", { name: "Periwinkle" }).getAttribute("aria-checked")).toBe("true");

    failing = false;
    await choose("Violet");

    await waitFor(() => {
      expect(screen.queryByText("This change was not saved.")).toBeNull();
    });
    expect(document.documentElement.getAttribute("data-accent")).toBe("violet");
  });

  it("go back to what the server holds when two changes of one field fail one after the other", async () => {
    stubMatchMedia(true);
    const releases: ((response: Response) => void)[] = [];
    const server = stubServer({ patch: () => new Promise<Response>((resolve) => releases.push(resolve)) });
    await openPreferences();
    expect(rootClasses()).toEqual(["dark"]);

    await choose("Dark");
    await choose("Light");
    expect(rootClasses()).toEqual(["light"]);

    await act(async () => {
      releases[0]?.(problem(503, "unavailable", "req-first"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(releases).toHaveLength(2);
    });
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    expect(rootClasses()).toEqual(["light"]);

    await act(async () => {
      releases[1]?.(problem(503, "unavailable", "req-second"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
    });
    expect(rootClasses()).toEqual(["dark"]);
    expect(window.localStorage.getItem("slugbase-theme")).toBe("system");
    expect(server.account().theme).toBe("system");
  });

  it("keeps a change that is still waiting to be saved when the one before it is saved", async () => {
    const releases: ((response: Response) => void)[] = [];
    const server = stubServer({ patch: () => new Promise<Response>((resolve) => releases.push(resolve)) });
    await openPreferences();

    await choose("Dark");
    await choose("Light");
    await act(async () => {
      releases[0]?.(json({ ...ACCOUNT, theme: "dark" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(releases).toHaveLength(2);
    });

    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    expect(rootClasses()).toEqual(["light"]);

    await act(async () => {
      releases[1]?.(json({ ...ACCOUNT, theme: "light" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("All changes saved");
    });
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    expect(await server.patches()).toEqual([{ theme: "dark" }, { theme: "light" }]);
  });

  it("leaves a session that ended while saving to the session handler: no error toast, no change kept", async () => {
    stubServer({ patch: () => Promise.resolve(problem(401, "unauthenticated", "req-401")) });
    await openPreferences();

    await choose("Dark");

    expect(await screen.findByText("Your session has ended")).toBeTruthy();
    expect(screen.queryByText("The change was not saved")).toBeNull();
  });

  it("does not show defaults when the account cannot be loaded, and loads it on retry", async () => {
    let failing = true;
    const account = ACCOUNT;
    vi.stubGlobal("fetch", (request: Request) => {
      const { pathname } = new URL(request.url);
      if (pathname === ME_PATH) {
        return Promise.resolve(failing ? problem(503, "unavailable", "req-get") : json(me(account)));
      }
      return signedIn(request);
    });
    await openPreferences().catch(() => undefined);

    expect(await screen.findByText("Your preferences could not be loaded", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();

    failing = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
    });
  });
});

describe("the theme toggle of the top bar", () => {
  it("keeps the choice in the account, and takes it back when it cannot be saved", async () => {
    let failing = false;
    const server = stubServer({
      patch: async (request) => {
        if (failing) {
          return problem(503, "unavailable", "req-patch");
        }
        return json({ ...ACCOUNT, ...((await request.json()) as object) });
      },
    });
    await openApp("/");
    await screen.findByRole("heading", { level: 1 });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
      await Promise.resolve();
    });
    expect(rootClasses()).toEqual(["dark"]);
    await waitFor(async () => {
      expect(await server.patches()).toEqual([{ theme: "dark" }]);
    });

    failing = true;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeTruthy();
    });
    expect(rootClasses()).toEqual(["dark"]);
  });
});

function ShortcutProbe(): ReactElement {
  useShortcut({ key: "c" }, () => {
    document.body.dataset["singleKey"] = String(Number(document.body.dataset["singleKey"] ?? "0") + 1);
  });
  useShortcut({ key: "k", mod: true }, () => {
    document.body.dataset["modified"] = String(Number(document.body.dataset["modified"] ?? "0") + 1);
  });
  return <p>Shortcut probe</p>;
}

const SHORTCUT_EXTENSION: WebExtension = { id: "shortcut-probe", slots: { "sidebar.footer": ShortcutProbe } };

describe("single-key shortcuts", () => {
  afterEach(() => {
    delete document.body.dataset["singleKey"];
    delete document.body.dataset["modified"];
  });

  it("run while the account has them on", async () => {
    stubServer();
    await openApp("/", [SHORTCUT_EXTENSION]);
    await screen.findByText("Shortcut probe");

    fireEvent.keyDown(document.body, { key: "c" });

    expect(document.body.dataset["singleKey"]).toBe("1");
  });

  it("are skipped once the switch is turned off, while a modifier shortcut keeps working", async () => {
    const server = stubServer();
    await openPreferences([SHORTCUT_EXTENSION]);
    await screen.findByText("Shortcut probe");

    await toggle("Single-key shortcuts");
    await waitFor(async () => {
      expect(await server.patches()).toEqual([{ singleKeyShortcuts: false }]);
    });
    fireEvent.keyDown(document.body, { key: "c" });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });

    expect(document.body.dataset["singleKey"]).toBeUndefined();
    expect(document.body.dataset["modified"]).toBe("1");
  });

  it("are skipped from the first page when the account turned them off, and come back when they are turned on", async () => {
    stubServer({ account: { ...ACCOUNT, singleKeyShortcuts: false } });
    await openPreferences([SHORTCUT_EXTENSION]);
    await screen.findByText("Shortcut probe");
    expect(screen.getByRole("switch", { name: "Single-key shortcuts" }).getAttribute("aria-checked")).toBe("false");

    fireEvent.keyDown(document.body, { key: "c" });
    expect(document.body.dataset["singleKey"]).toBeUndefined();

    await toggle("Single-key shortcuts");
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Single-key shortcuts" }).getAttribute("aria-checked")).toBe("true");
    });
    fireEvent.keyDown(document.body, { key: "c" });
    expect(document.body.dataset["singleKey"]).toBe("1");
  });

  it("run again when turning them off could not be saved", async () => {
    stubServer({ patch: () => Promise.resolve(problem(503, "unavailable", "req-patch")) });
    await openPreferences([SHORTCUT_EXTENSION]);
    await screen.findByText("Shortcut probe");

    await toggle("Single-key shortcuts");
    expect(await screen.findByText("This change was not saved.")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "c" });

    expect(document.body.dataset["singleKey"]).toBe("1");
  });
});

describe("the account request", () => {
  it("is asked for once when the app starts", async () => {
    const server = stubServer();
    await openApp("/");
    await screen.findByRole("heading", { level: 1 });

    const paths = server.fetch.mock.calls.map(([request]) => new URL(request.url).pathname);
    expect(paths.filter((path) => path === ME_PATH)).toHaveLength(1);
    expect(paths).toContain(SESSION_PATH);
  });
});
