import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { registerCommand } from "../src/palette/commands.ts";
import {
  ACCOUNT_BODY,
  ACTIVE_WORKSPACE_PATH,
  WORKSPACES_PATH,
  WORKSPACE_ID,
  allowSlowRender,
  json,
  meOf,
  renderApp,
  signedIn,
  stubBrowserApis,
  stubMatchMedia,
} from "./support.tsx";

// The command palette (doc 02 section 9.2, doc 03 section 9): how it opens and closes, where focus goes, what the empty view lists
// and how it shows a wait, a failure and nothing to list, the registry its commands come from, and what choosing an item does.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];

const OWNER = ACCOUNT_BODY.id;
const OTHER_OWNER = "0192f3a0-bbbb-7000-8000-0000000000ff";
const LIST = "/api/v1/bookmarks";

function bookmark(n: number, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`,
    ownerId: OWNER,
    url: `https://site${String(n)}.example.com/page`,
    host: `site${String(n)}.example.com`,
    title: `Bookmark ${String(n)}`,
    description: null,
    slug: null,
    forwarding: false,
    pinned: false,
    openCount: 0,
    lastOpenedAt: "2026-10-02T08:00:00.000Z",
    folders: [],
    tags: [],
    version: 1,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

function page(items: readonly Bookmark[]): Response {
  return json({ items, nextCursor: null, total: items.length });
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
}

let calls: Call[] = [];

interface Server {
  recent: () => Response;
  pinned: () => Response;
  account: object;
  /** Answers a request instead of the defaults, when it returns a response. */
  intercept?: (request: Request) => Response | Promise<Response> | undefined;
}

const RECENT = bookmark(1, { title: "Docs", slug: "docs", host: "docs.example.org", url: "https://docs.example.org/" });
const PINNED = bookmark(2, { title: "Mail", pinned: true, host: "mail.example.org", url: "https://mail.example.org/", lastOpenedAt: null });
const SHARED = bookmark(3, { title: "Shared board", ownerId: OTHER_OWNER, host: "board.example.org", url: "https://board.example.org/" });

function serve(overrides: Partial<Server> = {}): Server {
  const server: Server = { recent: () => page([RECENT, SHARED]), pinned: () => page([PINNED]), account: meOf(ACCOUNT_BODY), ...overrides };
  vi.stubGlobal(
    "fetch",
    vi.fn((request: Request): Promise<Response> => {
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname, search: url.searchParams });
      const intercepted = server.intercept?.(request);
      if (intercepted !== undefined) {
        return Promise.resolve(intercepted);
      }
      if (url.pathname === "/api/v1/me" && request.method === "GET") {
        return Promise.resolve(json(server.account));
      }
      if (url.pathname === LIST && request.method === "GET") {
        return Promise.resolve(url.searchParams.get("pinned") === "true" ? server.pinned() : url.searchParams.get("sort") === "recently_opened" ? server.recent() : page([]));
      }
      if (url.pathname === "/api/v1/me" && request.method === "PATCH") {
        return request.json().then((changes: object) => json({ ...ACCOUNT_BODY, ...changes }));
      }
      if (url.pathname.endsWith("/open") || url.pathname === "/api/v1/auth/logout" || url.pathname === ACTIVE_WORKSPACE_PATH) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return signedIn(request, () => Promise.reject(new Error(`unexpected call ${request.method} ${url.pathname}`)));
    }),
  );
  return server;
}

function to(method: string, path: string): Call[] {
  return calls.filter((call) => call.method === method && call.path === path);
}

let restoreWait: () => void = () => undefined;

beforeEach(() => {
  restoreWait = allowSlowRender();
  calls = [];
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  restoreWait();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
  document.body.querySelectorAll("[data-test-field]").forEach((element) => {
    element.remove();
  });
});

async function openApp(path = "/"): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("main", { hidden: true });
}

async function key(init: KeyboardEventInit, target: Element | Window = window): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, init);
    await Promise.resolve();
  });
}

async function click(element: HTMLElement, init: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    fireEvent.click(element, init);
    await Promise.resolve();
  });
}

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: "Search or run a command…" });
}

async function openPalette(): Promise<HTMLElement> {
  await key({ key: "k", ctrlKey: true });
  return screen.findByRole("dialog", { name: "Command palette" });
}

function labelsOf(group: HTMLElement): string[] {
  return within(group).getAllByRole("option").map((option) => option.querySelector("span.truncate")?.textContent ?? "");
}

async function groupOf(dialog: HTMLElement, name: string): Promise<HTMLElement> {
  return within(dialog).findByRole("group", { name });
}

describe("opening and closing the palette", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("has a command trigger in the top bar that opens it, and gives focus back to the trigger when Esc closes it", async () => {
    serve();
    await openApp();
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Search or run a command…" })).toBeTruthy();
    const button = trigger();
    button.focus();

    await click(button);
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(document.activeElement).toBe(within(dialog).getByRole("combobox", { name: "Search or run a command" }));
    await key({ key: "Escape" }, document.activeElement ?? window);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(button);
    });
  });

  it("opens with Ctrl K from the page and returns focus to the trigger when it closes", async () => {
    serve();
    await openApp();

    await openPalette();
    await key({ key: "Escape" }, document.activeElement ?? window);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger());
    });
  });

  it("opens with Command K, and Ctrl K again closes it", async () => {
    serve();
    await openApp();

    await key({ key: "k", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
    await key({ key: "k", ctrlKey: true });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
  });

  it("opens with Ctrl K from a text field and gives focus back to that field", async () => {
    serve();
    await openApp();
    const field = document.createElement("input");
    field.dataset.testField = "true";
    document.body.append(field);
    field.focus();

    await key({ key: "k", ctrlKey: true }, field);
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
    await key({ key: "Escape" }, document.activeElement ?? window);

    await waitFor(() => {
      expect(document.activeElement).toBe(field);
    });
  });

  it("leaves / alone on Home", async () => {
    serve();
    await openApp("/");

    await key({ key: "/" });

    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("opened over the bookmark modal, gives focus back to the field it came from and leaves the modal open", async () => {
    serve();
    await openApp("/?new=1");
    const modal = await screen.findByRole("dialog", { name: "New bookmark" });
    const field = within(modal).getAllByRole("textbox")[0] as HTMLElement;
    field.focus();

    await key({ key: "k", ctrlKey: true }, field);
    await screen.findByRole("dialog", { name: "Command palette" });
    await key({ key: "Escape" }, document.activeElement ?? window);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(field);
    });
    expect(screen.getByRole("dialog", { name: "New bookmark" })).toBeTruthy();
  });

  it("opens with / on a list page", async () => {
    serve();
    await openApp("/bookmarks");
    await key({ key: "/" });
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });

  it("leaves / to a text field on a list page", async () => {
    serve();
    await openApp("/bookmarks");
    const field = document.createElement("input");
    field.dataset.testField = "true";
    document.body.append(field);
    field.focus();

    await key({ key: "/" }, field);

    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("leaves / alone when the account turned single-key shortcuts off, and still opens with Ctrl K", async () => {
    serve({ account: meOf({ ...ACCOUNT_BODY, singleKeyShortcuts: false }) });
    await openApp("/bookmarks");

    await key({ key: "/" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    await key({ key: "k", ctrlKey: true });

    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });
});

describe("the default view", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("lists Recent, Pinned, Navigation and Actions, and asks for the recently opened and the pinned bookmarks", async () => {
    serve();
    await openApp();
    const dialog = await openPalette();

    const recent = await groupOf(dialog, "Recent");
    expect(labelsOf(recent)).toEqual(["Docs", "Shared board"]);
    expect(labelsOf(await groupOf(dialog, "Pinned"))).toEqual(["Mail"]);
    expect(labelsOf(await groupOf(dialog, "Navigation"))).toEqual(["Home", "Bookmarks", "Folders", "Tags", "Forwarding", "Settings"]);
    expect(labelsOf(await groupOf(dialog, "Actions"))).toEqual(["New bookmark", "New folder", "Switch workspace", "Toggle theme", "Sign out"]);
    expect(within(recent).getByText("docs.example.org · /go/docs")).toBeTruthy();
    const recentCall = to("GET", LIST).find((call) => call.search.get("sort") === "recently_opened");
    expect(recentCall?.search.get("limit")).toBe("5");
    const pinnedCall = to("GET", LIST).find((call) => call.search.get("pinned") === "true");
    expect(pinnedCall?.search.get("sort")).toBe("recent");
  });

  it("leaves a bookmark that was never opened out of Recent", async () => {
    serve({ recent: () => page([RECENT, bookmark(4, { title: "Never opened", lastOpenedAt: null })]) });
    await openApp();
    const dialog = await openPalette();

    expect(labelsOf(await groupOf(dialog, "Recent"))).toEqual(["Docs"]);
  });

  it("is a full-width sheet at the bottom of a phone's screen", async () => {
    serve();
    await openApp();
    const dialog = await openPalette();

    expect(dialog.className).toContain("max-sm:max-w-none");
    expect(dialog.className).toContain("max-sm:rounded-none");
    expect(within(dialog).getByRole("button", { name: "Close the command palette" }).className).toContain("sm:hidden");
  });

  it("shows the key hints in the footer", async () => {
    serve();
    await openApp();
    const dialog = await openPalette();

    const footer = dialog.querySelector<HTMLElement>("[data-slot='command-footer']");
    expect(footer?.textContent).toBe("↑↓navigate↵openCtrl↵new tabAlt↵editEscclose");
  });

  it("announces the number of items to a screen reader and narrows them by the query, keywords included", async () => {
    serve();
    await openApp();
    const dialog = await openPalette();
    await groupOf(dialog, "Recent");
    const status = (): string | null | undefined => dialog.querySelector("[role='status'][aria-live='polite']")?.textContent;
    expect(status()).toBe("14 results");

    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "dark" } });

    await waitFor(() => {
      expect(status()).toBe("1 result");
    });
    expect(within(dialog).getByRole("option", { name: /Toggle theme/ })).toBeTruthy();

    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "zzzz" } });
    await waitFor(() => {
      expect(status()).toBe("No results");
    });
    expect(within(dialog).queryByRole("option")).toBeNull();
  });

  it("shows skeleton rows in Recent and Pinned while they load", async () => {
    let answer: (response: Response) => void = () => undefined;
    serve({ intercept: (request) => (new URL(request.url).pathname === LIST ? new Promise<Response>((resolve) => (answer = resolve)) : undefined) });
    await openApp();
    const dialog = await openPalette();

    const skeletons = Array.from(dialog.querySelectorAll("[data-slot='command-group']")).map((group) => group.querySelectorAll("[data-slot='skeleton']").length);
    expect(skeletons.slice(0, 2)).toEqual([3, 3]);
    expect(dialog.querySelector("[role='status'][aria-live='polite']")?.textContent).toBe("Loading bookmarks");
    answer(page([]));
  });

  it("shows one compact empty state when Recent and Pinned are both empty", async () => {
    serve({ recent: () => page([]), pinned: () => page([]) });
    await openApp();
    const dialog = await openPalette();

    expect(await within(dialog).findByRole("heading", { name: "No bookmarks to show yet" })).toBeTruthy();
    expect(within(dialog).queryByRole("group", { name: "Recent" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Pinned" })).toBeNull();
    expect(labelsOf(await groupOf(dialog, "Navigation")).length).toBe(6);
  });

  it("shows an inline error row that retries when it is chosen, and lists the bookmarks after the retry", async () => {
    let failing = true;
    serve({ recent: () => (failing ? json({ type: "x", title: "x", status: 500, code: "internal_error", detail: "x", requestId: "r" }, { status: 500, contentType: "application/problem+json" }) : page([RECENT])) });
    await openApp();
    const dialog = await openPalette();

    const failed = await within(dialog).findByRole("option", { name: /The bookmarks could not be loaded\./ }, { timeout: 10_000 });
    expect(within(failed).getByText("Try again")).toBeTruthy();
    expect(dialog.querySelector("[role='status'][aria-live='polite']")?.textContent).toBe("The bookmarks could not be loaded.");
    expect(within(dialog).getByRole("group", { name: "Pinned" })).toBeTruthy();
    failing = false;
    await click(failed);

    expect(labelsOf(await groupOf(dialog, "Recent"))).toEqual(["Docs"]);
    expect(within(dialog).queryByRole("option", { name: /could not be loaded/ })).toBeNull();
  });

  it("has no accessibility violations", async () => {
    serve();
    await openApp();
    const dialog = await openPalette();
    await groupOf(dialog, "Recent");

    const results = await axe(dialog, { rules: { region: { enabled: false } } });

    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });

  it("is in German in a German browser", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    serve({ account: meOf({ ...ACCOUNT_BODY, locale: "de" }) });
    await openApp();

    await key({ key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Befehlspalette" });

    expect(labelsOf(await groupOf(dialog, "Navigation"))).toEqual(["Start", "Lesezeichen", "Ordner", "Tags", "Weiterleitung", "Einstellungen"]);
    expect(labelsOf(await groupOf(dialog, "Aktionen"))).toEqual(["Neues Lesezeichen", "Neuer Ordner", "Workspace wechseln", "Design umschalten", "Abmelden"]);
    expect(within(dialog).getByRole("group", { name: "Zuletzt geöffnet" })).toBeTruthy();
  });
});

describe("the command registry", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("lists a command a feature registers, finds it by its keywords, runs it and drops it when it is removed", async () => {
    serve();
    const run = vi.fn<() => void>();
    const remove = registerCommand({
      id: "test.export",
      group: "actions",
      order: 5,
      name: (t) => t("palette.command.tags.name") + " export",
      keywords: () => "download backup",
      run,
    });
    await openApp();
    const dialog = await openPalette();

    expect(labelsOf(await groupOf(dialog, "Actions"))[0]).toBe("Tags export");
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "backup" } });
    await click(await within(dialog).findByRole("option", { name: /Tags export/ }));

    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
    remove();
    await openPalette();
    expect(within(screen.getByRole("dialog")).queryByRole("option", { name: /Tags export/ })).toBeNull();
  });

  it("replaces a command registered again under the same id", async () => {
    serve();
    const first = registerCommand({ id: "test.same", group: "actions", name: () => "First", keywords: () => "", run: () => undefined });
    const second = registerCommand({ id: "test.same", group: "actions", name: () => "Second", keywords: () => "", run: () => undefined });
    await openApp();
    const dialog = await openPalette();

    const actions = labelsOf(await groupOf(dialog, "Actions"));
    expect(actions).toContain("Second");
    expect(actions).not.toContain("First");
    first();
    second();
  });

  it("leaves a command out when its availability check says no", async () => {
    serve();
    const remove = registerCommand({ id: "test.never", group: "navigation", name: () => "Never offered", keywords: () => "", when: () => false, run: () => undefined });
    await openApp();
    const dialog = await openPalette();

    expect(labelsOf(await groupOf(dialog, "Navigation"))).not.toContain("Never offered");
    remove();
  });
});

describe("choosing an item", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("goes to the page of a navigation command and closes the palette", async () => {
    serve();
    await openApp();
    const dialog = await openPalette();

    await click(await within(dialog).findByRole("option", { name: /^Bookmarks/ }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/bookmarks");
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
  });

  it("opens the bookmark modal for New bookmark and leaves focus in the modal", async () => {
    serve();
    await openApp();
    const dialog = await openPalette();

    await click(await within(dialog).findByRole("option", { name: /New bookmark/ }));

    const modal = await screen.findByRole("dialog", { name: "New bookmark" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
    expect(window.location.search).toContain("new=1");
    expect(modal.contains(document.activeElement)).toBe(true);
  });

  it("toggles the theme and saves the choice", async () => {
    serve();
    await openApp();
    const before = document.documentElement.classList.contains("dark");
    const dialog = await openPalette();

    await click(await within(dialog).findByRole("option", { name: /Toggle theme/ }));

    expect(document.documentElement.classList.contains("dark")).toBe(!before);
  });

  it("signs out", async () => {
    serve();
    await openApp();
    const dialog = await openPalette();

    await click(await within(dialog).findByRole("option", { name: /Sign out/ }));

    await waitFor(() => {
      expect(to("POST", "/api/v1/auth/logout")).toHaveLength(1);
    });
  });

  it("switches workspace in the palette itself, from a list of the account's workspaces", async () => {
    serve({
      intercept: (request) => {
        if (new URL(request.url).pathname === WORKSPACES_PATH && request.method === "GET") {
          return json({
            items: [
              { id: WORKSPACE_ID, name: "Home", role: "owner", memberCount: 1 },
              { id: "0192f3a0-cccc-7000-8000-000000000002", name: "Team", role: "member", memberCount: 4 },
            ],
            canCreate: false,
          });
        }
        return undefined;
      },
    });
    await openApp();
    const dialog = await openPalette();

    await click(await within(dialog).findByRole("option", { name: /Switch workspace/ }));

    expect(await within(dialog).findByRole("option", { name: /Team/ })).toBeTruthy();
    expect(within(dialog).getByRole("option", { name: /Home/ }).textContent).toContain("Current");
    expect(within(dialog).queryByRole("group", { name: "Navigation" })).toBeNull();
    await click(within(dialog).getByRole("option", { name: /Team/ }));

    await waitFor(() => {
      expect(to("PUT", ACTIVE_WORKSPACE_PATH)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
  });

  it("opens a bookmark in a new tab with Ctrl Enter and counts the open", async () => {
    serve();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openApp();
    const dialog = await openPalette();
    await groupOf(dialog, "Recent");
    const input = within(dialog).getByRole("combobox");

    await key({ key: "Enter", ctrlKey: true }, input);

    expect(open).toHaveBeenCalledWith("https://docs.example.org/", "_blank", "noopener,noreferrer");
    await waitFor(() => {
      expect(to("POST", `${LIST}/${RECENT.id}/open`)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
  });

  it("edits the highlighted bookmark with Alt Enter when it is the member's own, and does nothing for another member's", async () => {
    serve();
    await openApp();
    const dialog = await openPalette();
    await groupOf(dialog, "Recent");
    const input = within(dialog).getByRole("combobox");

    await key({ key: "ArrowDown" }, input);
    await key({ key: "Enter", altKey: true }, input);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(window.location.search).not.toContain("bookmark=");

    await key({ key: "ArrowUp" }, input);
    await key({ key: "Enter", altKey: true }, input);

    await waitFor(() => {
      expect(window.location.search).toContain(`bookmark=${RECENT.id}`);
    });
  });
});
