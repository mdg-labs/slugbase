import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, WORKSPACE_LIST_BODY, allowSlowRender, json, meOf, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The scope filter, the shared marker and what a recipient may do on `/bookmarks` (doc 03 sections 3.1 to 3.5, doc 02 sections 8.2
// and 8.3, Q22) against the handlers generated from openapi.json. The failure scenarios are a scope offered where the workspace
// has no sharing entitlement, a shared bookmark that looks like the member's own, an owner shown for an ownerless bookmark, a
// shared bookmark that offers an edit, a pin or the modal, a mixed selection that keeps an own-only action enabled or loses
// "Open all", a select-all whose shared bookmarks are not among the loaded ones, and an empty shared list that reads as a failure.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const LIST = "/api/v1/bookmarks";
const GRACE = "0192f3a0-bbbb-7000-8000-000000000002";

function idOf(n: number): string {
  return `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`;
}

function bookmark(n: number, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: idOf(n),
    ownerId: ACCOUNT_BODY.id,
    url: `https://site${String(n)}.example.com/page`,
    host: `site${String(n)}.example.com`,
    title: `Bookmark ${String(n)}`,
    description: null,
    slug: null,
    forwarding: false,
    pinned: false,
    openCount: 0,
    lastOpenedAt: null,
    owner: null,
    sharedVia: null,
    folders: [],
    tags: [],
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

function shared(n: number, overrides: Partial<Bookmark> = {}): Bookmark {
  return bookmark(n, { ownerId: GRACE, owner: { accountId: GRACE, displayName: "Grace Hopper" }, sharedVia: "direct", ...overrides });
}

function formerMembers(n: number): Bookmark {
  return bookmark(n, { ownerId: null, owner: null, sharedVia: "folder" });
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
}

interface World {
  sharing: boolean;
  /** The bookmarks of each scope, for the list and for the identifiers. */
  byScope: Record<string, readonly Bookmark[]>;
  /** Holds the answer to the list of a scope until the promise settles. */
  holdList: Map<string, Promise<void>>;
  /** How many bookmarks of a scope the list answers with, the rest being for a later page. */
  loadOnly: number | undefined;
}

let world: World;
let calls: Call[] = [];

function newWorld(): World {
  return { sharing: true, byScope: {}, holdList: new Map(), loadOnly: undefined };
}

function inScope(scope: string): readonly Bookmark[] {
  return world.byScope[scope] ?? [];
}

function entitlementsBody() {
  return {
    entitlements: {
      "bookmarks.max": "unlimited",
      "seats.max": "unlimited",
      "workspaces.ownMax": "unlimited",
      "ai.suggestions": true,
      "sharing.members": world.sharing,
      "sharing.teams": world.sharing,
      "members.invite": true,
      "teams.manage": true,
      "audit.log": true,
    },
    usage: { "bookmarks.used": 2, "seats.used": 3, "workspaces.owned": 1 },
    upgradeAvailable: true,
  };
}

function serve(): void {
  server.use(
    ...createResolverHandlers(document_, {
      getMe: () => json(meOf(ACCOUNT_BODY)),
      getEntitlements: () => json(entitlementsBody()),
      listBookmarks: async (request) => {
        const scope = new URL(request.url).searchParams.get("scope") ?? "all";
        await world.holdList.get(scope);
        const all = inScope(scope);
        const items = world.loadOnly === undefined ? all : all.slice(0, world.loadOnly);
        return json({ items, nextCursor: items.length < all.length ? "next" : null, total: all.length });
      },
      listBookmarkIds: (request) => {
        const scope = new URL(request.url).searchParams.get("scope") ?? "all";
        return json({ ids: inScope(scope).map((item) => item.id), truncated: false });
      },
      getBookmark: (request) => {
        const found = Object.values(world.byScope)
          .flat()
          .find(({ id }) => new URL(request.url).pathname.endsWith(id));
        return found === undefined ? json({}, { status: 404 }) : json(found, { headers: { ETag: '"3"' } });
      },
    }),
    ...createHandlers(document_, { scenario: { name: "shared-list", fixtures: { listWorkspaces: WORKSPACE_LIST_BODY } } }),
  );
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname, params: url.searchParams });
  });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
});

afterAll(() => {
  restoreWait();
});

beforeEach(() => {
  world = newWorld();
  calls = [];
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function openApp(path: string): Promise<void> {
  serve();
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function key(init: KeyboardEventInit, target: Element | Window = window): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, init);
    await Promise.resolve();
  });
}

function box(n: number): HTMLElement {
  return screen.getByRole("checkbox", { name: `Select Bookmark ${String(n)}` });
}

function bar(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Selected bookmarks" });
}

function item(n: number): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-item-id="${idOf(n)}"]`);
  expect(found).not.toBeNull();
  return found as HTMLElement;
}

function listCalls(): Call[] {
  return calls.filter((call) => call.method === "GET" && call.path === LIST);
}

function scopeGroup(): HTMLElement {
  return screen.getByRole("radiogroup", { name: "Scope" });
}

async function menuOf(title: string): Promise<string[]> {
  await press(await screen.findByRole("button", { name: `Actions for ${title}` }));
  const menu = await screen.findByRole("menu");
  return within(menu)
    .getAllByRole("menuitem")
    .map((entry) => entry.textContent);
}

describe("the scope filter", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("offers All, Mine, Shared with me and Shared by me where the workspace may share", async () => {
    world.byScope.all = [bookmark(1)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    await waitFor(() => {
      expect(within(scopeGroup()).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["All", "Mine", "Shared with me", "Shared by me"]);
    });
  });

  it("offers only All and Mine where the entitlements grant no sharing", async () => {
    world.sharing = false;
    world.byScope.all = [bookmark(1)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    await waitFor(() => {
      expect(calls.some((call) => call.path.endsWith("/entitlements"))).toBe(true);
    });
    await waitFor(() => {
      expect(within(scopeGroup()).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["All", "Mine"]);
    });
  });

  it("writes the choice to the address and asks the API for that scope", async () => {
    world.byScope.all = [bookmark(1), shared(2)];
    world.byScope.shared_with_me = [shared(2)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    await press(await screen.findByRole("radio", { name: "Shared with me" }));

    await waitFor(() => {
      expect(window.location.search).toBe("?scope=shared_with_me");
    });
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Bookmark 1" })).toBeNull();
    });
    screen.getByRole("link", { name: "Bookmark 2" });
    expect(listCalls().at(-1)?.params.get("scope")).toBe("shared_with_me");

    await press(screen.getByRole("radio", { name: "Shared by me" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?scope=shared_by_me");
    });
    await press(screen.getByRole("radio", { name: "All" }));
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });

  it("opens on the scope of the address, with a chip that takes it off", async () => {
    world.byScope.all = [bookmark(1), shared(2)];
    world.byScope.shared_with_me = [shared(2)];
    await openApp("/bookmarks?scope=shared_with_me");
    await screen.findByRole("link", { name: "Bookmark 2" });

    expect(listCalls().every((call) => call.params.get("scope") === "shared_with_me")).toBe(true);
    await press(screen.getByRole("button", { name: "Remove filter: Shared with me" }));
    await screen.findByRole("link", { name: "Bookmark 1" });
    expect(window.location.search).toBe("");
  });

  it("shows the list's loading state while a scope loads, and a plain empty state when nothing is shared", async () => {
    world.byScope.all = [bookmark(1)];
    world.byScope.shared_with_me = [];
    let release: () => void = () => undefined;
    world.holdList.set(
      "shared_with_me",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    await press(await screen.findByRole("radio", { name: "Shared with me" }));
    await screen.findByRole("status", { name: "Loading the bookmarks" });
    expect(screen.queryByText("Nothing has been shared with you yet")).toBeNull();

    release();
    await screen.findByText("Nothing has been shared with you yet");
    expect(screen.queryByText("No bookmarks match these filters")).toBeNull();
  });

  it("says no bookmarks match, not that nothing is shared, once another filter narrows the shared list", async () => {
    world.byScope.shared_with_me = [];
    await openApp("/bookmarks?scope=shared_with_me&pinned=true");

    await screen.findByText("No bookmarks match these filters");
    expect(screen.queryByText("Nothing has been shared with you yet")).toBeNull();
  });
});

describe("shared bookmarks in the list", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("marks a shared card with its owner and an ownerless one as from a former member, and leaves the member's own unmarked", async () => {
    world.byScope.all = [bookmark(1), shared(2), formerMembers(3)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    expect(within(item(1)).queryByText("Shared")).toBeNull();
    expect(within(item(2)).getByText("Shared")).toBeTruthy();
    expect(within(item(2)).getByText("Grace Hopper")).toBeTruthy();
    expect(within(item(3)).getByText("Shared")).toBeTruthy();
    expect(within(item(3)).getByText("Former member")).toBeTruthy();
    expect(within(item(3)).queryByText("Grace Hopper")).toBeNull();
  });

  it("marks the rows of the table the same way", async () => {
    world.byScope.all = [bookmark(1), shared(2), formerMembers(3)];
    await openApp("/bookmarks?view=table");
    await screen.findByRole("link", { name: "Bookmark 1" });

    const rows = screen.getAllByRole("row");
    const rowOf = (title: string): HTMLElement => rows.find((row) => within(row).queryByText(title) !== null) as HTMLElement;
    expect(within(rowOf("Bookmark 1")).queryByText("Shared")).toBeNull();
    expect(within(rowOf("Bookmark 2")).getByText("Shared")).toBeTruthy();
    expect(within(rowOf("Bookmark 2")).getByText("Grace Hopper")).toBeTruthy();
    expect(within(rowOf("Bookmark 3")).getByText("Former member")).toBeTruthy();
  });

  it("shows the owner's name as text, whatever it holds", async () => {
    world.byScope.all = [shared(1, { owner: { accountId: GRACE, displayName: "<img src=x onerror=alert(1)>" } })];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    expect(within(item(1)).getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(item(1).querySelector("[onerror]")).toBeNull();
  });

  it("limits the actions of a shared bookmark to Open and Copy address, and keeps the member's own", async () => {
    world.byScope.all = [bookmark(1), shared(2)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    expect(await menuOf("Bookmark 2")).toEqual(["Open", "Copy address"]);
  });

  it("keeps Edit, Share, Pin and Delete on the member's own bookmark", async () => {
    world.byScope.all = [bookmark(1), shared(2)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    expect(await menuOf("Bookmark 1")).toEqual(["Edit", "Share", "Pin", "Delete"]);
  });

  it("opens a shared bookmark from its actions, counting the open, and copies its address", async () => {
    world.byScope.all = [shared(2)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 2" });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });

    await menuOf("Bookmark 2");
    await press(screen.getByRole("menuitem", { name: "Open" }));
    expect(open).toHaveBeenCalledWith("https://site2.example.com/page", "_blank", "noopener,noreferrer");
    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.path === `${LIST}/${idOf(2)}/open`)).toBe(true);
    });

    await menuOf("Bookmark 2");
    await press(screen.getByRole("menuitem", { name: "Copy address" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("https://site2.example.com/page");
    });
    await screen.findByText("Address copied.");
    Reflect.deleteProperty(window.navigator, "clipboard");
  });

  it("says so when the address could not be copied", async () => {
    world.byScope.all = [shared(2)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 2" });
    const writeText = vi.fn().mockRejectedValue(new Error("refused"));
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });

    await menuOf("Bookmark 2");
    await press(screen.getByRole("menuitem", { name: "Copy address" }));

    expect((await screen.findAllByText("The address could not be copied. Copy it from the bookmark’s link instead.")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Address copied.")).toBeNull();
    Reflect.deleteProperty(window.navigator, "clipboard");
  });

  it("leaves E and P to the member's own bookmarks", async () => {
    world.byScope.all = [bookmark(1), shared(2)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    item(2).focus();
    await key({ key: "e" }, item(2));
    await key({ key: "p" }, item(2));
    expect(window.location.search).toBe("");
    expect(calls.some((call) => call.method === "PATCH" || call.method === "POST")).toBe(false);

    item(1).focus();
    await key({ key: "e" }, item(1));
    expect(window.location.search).toBe(`?bookmark=${idOf(1)}`);
  });

  it("does not open the modal's editor for a shared bookmark named by the address", async () => {
    world.byScope.all = [shared(2)];
    await openApp(`/bookmarks?bookmark=${idOf(2)}`);

    await screen.findByText("This bookmark is shared with you");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /Title/u })).toBeNull();
  });
});

describe("a selection with shared bookmarks", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("keeps every action for a selection of the member's own bookmarks", async () => {
    world.byScope.all = [bookmark(1), bookmark(2), shared(3)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    await press(box(1));
    await press(box(2));

    const toolbar = within(bar());
    expect((toolbar.getByRole<HTMLButtonElement>("button", { name: "Open all" })).disabled).toBe(false);
    for (const name of ["Add to folder", "Remove from folder", "Add tags", "Remove tags", "Share", "Pin", "Unpin", "Delete"]) {
      expect((toolbar.getByRole<HTMLButtonElement>("button", { name })).disabled).toBe(false);
    }
    expect(toolbar.queryByText(/shared bookmark/u)).toBeNull();
  });

  it("keeps Open all and disables the own-only actions, saying which were limited and why", async () => {
    world.byScope.all = [bookmark(1), shared(2)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    await press(box(1));
    await press(box(2));

    const toolbar = within(bar());
    expect((toolbar.getByRole<HTMLButtonElement>("button", { name: "Open all" })).disabled).toBe(false);
    for (const name of ["Add to folder", "Remove from folder", "Add tags", "Remove tags", "Share", "Pin", "Unpin", "Delete"]) {
      expect((toolbar.getByRole<HTMLButtonElement>("button", { name })).disabled).toBe(true);
    }
    toolbar.getByText("1 shared bookmark is selected, so only Open all is available.");

    const delete_ = toolbar.getByRole("button", { name: "Delete" });
    const trigger = delete_.parentElement as HTMLElement;
    await act(async () => {
      trigger.focus();
      await Promise.resolve();
    });
    await screen.findByText("Bookmarks shared with you can be opened but not changed. Deselect them to use this action.");
  });

  it("sends no change to the API for a limited action, and opens the selected bookmarks with Open all", async () => {
    world.byScope.all = [bookmark(1), shared(2)];
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    await press(box(1));
    await press(box(2));
    await press(within(bar()).getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await press(within(bar()).getByRole("button", { name: "Open all" }));

    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith("https://site1.example.com/page", "_blank", "noopener,noreferrer");
    expect(open).toHaveBeenCalledWith("https://site2.example.com/page", "_blank", "noopener,noreferrer");
    await waitFor(() => {
      expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/open"))).toHaveLength(2);
    });
    expect(calls.some((call) => call.path === `${LIST}/bulk`)).toBe(false);
  });

  it("treats every selected bookmark of the shared-with-me list as shared", async () => {
    world.byScope.shared_with_me = [shared(2), shared(3)];
    await openApp("/bookmarks?scope=shared_with_me");
    await screen.findByRole("link", { name: "Bookmark 2" });

    await press(box(2));

    expect((within(bar()).getByRole<HTMLButtonElement>("button", { name: "Delete" })).disabled).toBe(true);
    expect((within(bar()).getByRole<HTMLButtonElement>("button", { name: "Open all" })).disabled).toBe(false);
  });

  it("limits a select-all whose shared bookmarks are not loaded, by asking which of the matches are shared", async () => {
    // Two bookmarks match and one is loaded; the other, shared with the member, is only in the answer to the select-all.
    world.byScope.all = [bookmark(1), shared(2)];
    world.byScope.shared_with_me = [shared(2)];
    world.loadOnly = 1;
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    await press(box(1));
    await press(await within(bar()).findByRole("button", { name: "Select all 2 matching" }));

    await within(bar()).findByText("2 selected");
    await waitFor(() => {
      expect((within(bar()).getByRole<HTMLButtonElement>("button", { name: "Delete" })).disabled).toBe(true);
    });
    const idCalls = calls.filter((call) => call.path === `${LIST}/ids`);
    expect(idCalls.map((call) => call.params.get("scope"))).toEqual([null, "shared_with_me"]);
  });

  it("asks only once for the identifiers where the list is already one scope", async () => {
    world.byScope.mine = [bookmark(1), bookmark(2)];
    world.loadOnly = 1;
    await openApp("/bookmarks?scope=mine");
    await screen.findByRole("link", { name: "Bookmark 1" });

    await press(box(1));
    await press(await within(bar()).findByRole("button", { name: "Select all 2 matching" }));

    await within(bar()).findByText("2 selected");
    expect(calls.filter((call) => call.path === `${LIST}/ids`)).toHaveLength(1);
    expect((within(bar()).getByRole<HTMLButtonElement>("button", { name: "Delete" })).disabled).toBe(false);
  });
});
