import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, meBody, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The Export selection action of the bulk bar (doc 03 section 3.4, doc 02 section 5.8, doc 04 section 10.9) against the handlers generated from openapi.json.
// The failure scenarios are an export that holds more or other bookmarks than the ones selected (the whole library, or the ids of a stale selection), a "select all
// matching" that is sent as ids the API refuses or without the list's filters, a failed or given-up request that saves a file, reports success or loses the selection,
// an action that can be started again while one runs, and an export offered for a selection no request can name.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const GRACE = "0192f3a0-bbbb-7000-8000-000000000002";
const JSON_EXPORT = "/api/v1/export/json";
const HTML_EXPORT = "/api/v1/export/netscape";
const JSON_FILE = '{"format":"slugbase-export","version":1,"bookmarks":[]}';
const HTML_FILE = "<!DOCTYPE NETSCAPE-Bookmark-file-1><DL></DL>";

const idOf = (n: number): string => `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`;
const idsOf = (count: number): string[] => Array.from({ length: count }, (_, index) => idOf(index + 1));

function bookmark(n: number, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: idOf(n),
    ownerId: OWNER,
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

const shared = (n: number): Bookmark => bookmark(n, { ownerId: GRACE, owner: { accountId: GRACE, displayName: "Grace Hopper" }, sharedVia: "direct" });

function page(items: readonly Bookmark[], total: number | null = items.length): unknown {
  return { items, nextCursor: total !== null && total > items.length ? "next" : null, total, ...(total === null ? { totalAtLeast: 10000 } : {}) };
}

interface Seen {
  readonly path: string;
  readonly params: URLSearchParams;
}

interface World {
  seen: Seen[];
  /** Answers an export in place of the file, when it returns a response. */
  answer: (seen: Seen) => Response | Promise<Response | undefined> | undefined;
  /** How many bookmarks the server says the file holds; the number of identifiers named when left out. */
  count: (seen: Seen) => string | undefined;
  clicks: { readonly href: string; readonly download: string }[];
  created: Blob[];
}

let world: World;

const newWorld = (): World => ({ seen: [], answer: () => undefined, count: (seen) => String(seen.params.getAll("id").length), clicks: [], created: [] });

function problemOf(status: number, code: string, headers: Record<string, string> = {}): Response {
  return json(
    { type: `https://slugbase.app/problems/${code}`, title: code, status, code, detail: "Hostile <b>English</b> detail of the server", requestId: "req-export" },
    { status, contentType: "application/problem+json", headers },
  );
}

function entitlementsBody() {
  return {
    entitlements: {
      "bookmarks.max": "unlimited",
      "seats.max": "unlimited",
      "workspaces.ownMax": "unlimited",
      "ai.suggestions": true,
      "sharing.members": true,
      "sharing.teams": true,
      "members.invite": true,
      "teams.manage": true,
      "audit.log": true,
    },
    usage: { "bookmarks.used": 3, "seats.used": 3, "workspaces.owned": 1 },
    upgradeAvailable: true,
  };
}

function serve(scenario: Omit<Scenario, "name">): void {
  server.use(...createHandlers(document_, { scenario: { name: "bulk-export", ...scenario } }));
  const handle = (body: string, contentType: string, name: string) => async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const seen: Seen = { path: url.pathname, params: url.searchParams };
    world.seen.push(seen);
    const answered = await world.answer(seen);
    if (answered !== undefined) {
      return answered;
    }
    const count = world.count(seen);
    return new Response(body, { headers: { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${name}"`, ...(count === undefined ? {} : { "X-Export-Count": count }) } });
  };
  server.use(
    ...createResolverHandlers(document_, {
      getMe: () => json(meBody()),
      getEntitlements: () => json(entitlementsBody()),
      exportJson: handle(JSON_FILE, "application/json", "slugbase-export-2026-05-05.json"),
      exportNetscape: handle(HTML_FILE, "text/html; charset=utf-8", "slugbase-export-2026-05-05.html"),
    }),
  );
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  restoreWait();
  server.close();
});

beforeEach(() => {
  world = newWorld();
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  let next = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      world.created.push(blob);
      next += 1;
      return `blob:bulk-export-${String(next)}`;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: () => undefined });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
    world.clicks.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

async function openApp(path = "/bookmarks"): Promise<ReturnType<typeof renderApp>> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  const rendered = renderApp(<App />);
  // A role query would run again on every change of the list while its 120 rows render, and take the time from the render.
  await screen.findByText("Bookmark 1");
  return rendered;
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

// The element of a role and an aria-label. A role query computes the accessible name of every element of the role, which for the checkboxes of a list of 120 took about a quarter of a second a lookup.
function labelled(role: string, name: string): HTMLElement {
  const found = document.body.querySelector<HTMLElement>(`[role="${role}"][aria-label="${name}"]`);
  if (found === null) {
    throw new Error(`No ${role} named "${name}"`);
  }
  return found;
}

const checkbox = (n: number): HTMLElement => labelled("checkbox", `Select Bookmark ${String(n)}`);

async function select(...numbers: number[]): Promise<void> {
  for (const n of numbers) {
    await press(checkbox(n));
  }
}

async function key(init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(window, init);
    await Promise.resolve();
  });
}

const bar = (): HTMLElement => labelled("toolbar", "Selected bookmarks");

async function openExport(title: string): Promise<HTMLElement> {
  await press(within(bar()).getByRole("button", { name: "Export selection" }));
  return screen.findByRole("dialog", { name: title });
}

const exportsSent = (): Seen[] => world.seen.filter((seen) => seen.path === JSON_EXPORT || seen.path === HTML_EXPORT);

const LIST_OF_THREE = { listBookmarks: page([bookmark(1), bookmark(2), bookmark(3)]) };

describe("exporting the selection", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks for the format, then downloads the selected bookmarks as SlugBase JSON by their identifiers and reports how many the file holds", async () => {
    serve({ fixtures: LIST_OF_THREE });
    await openApp();
    await select(1, 3);

    const dialog = await openExport("Export 2 selected bookmarks");
    expect(exportsSent()).toHaveLength(0);
    const group = within(dialog).getByRole("radiogroup", { name: "File format" });
    expect(within(group).getByRole("radio", { name: "SlugBase JSON (recommended)" }).getAttribute("aria-checked")).toBe("true");
    await press(within(dialog).getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    expect(exportsSent()).toHaveLength(1);
    expect(exportsSent()[0]?.path).toBe(JSON_EXPORT);
    expect(exportsSent()[0]?.params.getAll("id")).toEqual([idOf(1), idOf(3)]);
    expect([...(exportsSent()[0]?.params.keys() ?? [])]).toEqual(["id", "id"]);
    expect(world.clicks[0]).toMatchObject({ href: "blob:bulk-export-1", download: "slugbase-export-2026-05-05.json" });
    expect(await world.created[0]?.text()).toBe(JSON_FILE);
    expect((await screen.findAllByText("2 bookmarks exported")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("slugbase-export-2026-05-05.json").length).toBeGreaterThan(0);
    // The selection stays, for the next action.
    expect(within(bar()).getByText("2 selected")).toBeDefined();
  });

  it("downloads the browser bookmark file when Netscape HTML is chosen", async () => {
    serve({ fixtures: LIST_OF_THREE });
    await openApp();
    await select(2);

    const dialog = await openExport("Export 1 selected bookmark");
    await press(within(dialog).getByRole("radio", { name: "Netscape HTML" }));
    await press(within(dialog).getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    expect(exportsSent().map((seen) => seen.path)).toEqual([HTML_EXPORT]);
    expect(exportsSent()[0]?.params.getAll("id")).toEqual([idOf(2)]);
    expect(world.clicks[0]?.download).toBe("slugbase-export-2026-05-05.html");
    expect(await world.created[0]?.text()).toBe(HTML_FILE);
    expect((await screen.findAllByText("1 bookmark exported")).length).toBeGreaterThan(0);
  });

  it("states the number the server counted, which is fewer than the ones selected when the server could not read some", async () => {
    world.count = () => "1";
    serve({ fixtures: LIST_OF_THREE });
    await openApp();
    await select(1, 2);

    await press(within(await openExport("Export 2 selected bookmarks")).getByRole("button", { name: "Export" }));

    expect((await screen.findAllByText("1 bookmark exported")).length).toBeGreaterThan(0);
    expect(screen.queryByText("2 bookmarks exported")).toBeNull();
  });

  it("does not guess a count when the server sends none", async () => {
    world.count = () => undefined;
    serve({ fixtures: LIST_OF_THREE });
    await openApp();
    await select(1, 2);

    await press(within(await openExport("Export 2 selected bookmarks")).getByRole("button", { name: "Export" }));

    expect((await screen.findAllByText("Export downloaded")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/bookmarks? exported/)).toBeNull();
  });

  it("shows the action as loading and the bar as busy while the file is made, and starts no second export meanwhile", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.answer = async () => {
      await held;
      return undefined;
    };
    serve({ fixtures: LIST_OF_THREE });
    await openApp();
    await select(1, 2);
    await press(within(await openExport("Export 2 selected bookmarks")).getByRole("button", { name: "Export" }));

    expect((await screen.findAllByText("Preparing your export…")).length).toBeGreaterThan(0);
    const busy = document.querySelector<HTMLElement>("[data-slot='bulk-bar']") as HTMLElement;
    expect(busy.getAttribute("aria-busy")).toBe("true");
    const action = within(busy).getByRole("button", { name: /Export selection/, hidden: true });
    expect(action.hasAttribute("data-loading")).toBe(true);
    expect(action.getAttribute("aria-disabled")).toBe("true");
    await press(action);
    expect(screen.queryByRole("dialog", { name: /^Export/ })).toBeNull();
    expect(exportsSent()).toHaveLength(1);
    expect(world.clicks).toEqual([]);

    await act(async () => {
      release();
      await held;
    });

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    await waitFor(() => {
      expect(document.querySelector<HTMLElement>("[data-slot='bulk-bar']")?.getAttribute("aria-busy")).not.toBe("true");
    });
    expect(exportsSent()).toHaveLength(1);
  });

  it.each([
    ["a rate limit, with the wait the server asks for", () => problemOf(429, "rate_limited", { "Retry-After": "90" }), "Too many exports. Try again in 2 minutes."],
    ["an unavailable server", () => problemOf(503, "unavailable"), "The server is busy. Try again in a moment."],
    ["a selection the API refuses", () => problemOf(422, "validation_failed"), "The export is too large for one file. Narrow the filters and try again."],
    ["a failure", () => problemOf(500, "internal"), "The export could not be made. Try again."],
  ])("tells %s in a toast in the language of the page, saves nothing and keeps the selection", async (_name, answer, message) => {
    world.answer = () => answer();
    serve({ fixtures: LIST_OF_THREE });
    await openApp();
    await select(1, 2);

    await press(within(await openExport("Export 2 selected bookmarks")).getByRole("button", { name: "Export" }));

    expect((await screen.findAllByText("The export was not downloaded")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Hostile/)).toBeNull();
    expect(screen.queryByText(/bookmarks? exported/)).toBeNull();
    expect(world.clicks).toEqual([]);
    expect(world.created).toEqual([]);
    expect(within(bar()).getByText("2 selected")).toBeDefined();
    expect(checkbox(1).getAttribute("aria-checked")).toBe("true");
    // The action is available again.
    expect(within(bar()).getByRole("button", { name: "Export selection" }).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("tells a connection that failed, saves nothing and keeps the selection", async () => {
    world.answer = () => Response.error();
    serve({ fixtures: LIST_OF_THREE });
    await openApp();
    await select(1);

    await press(within(await openExport("Export 1 selected bookmark")).getByRole("button", { name: "Export" }));

    expect((await screen.findAllByText("The server could not be reached. Check your connection and try again.")).length).toBeGreaterThan(0);
    expect(world.clicks).toEqual([]);
    expect(within(bar()).getByText("1 selected")).toBeDefined();
  });

  it("gives up the request when the page is left, and saves nothing of a file that arrives afterwards", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.answer = async (seen) => {
      expect(seen.path).toBe(JSON_EXPORT);
      await held;
      return undefined;
    };
    serve({ fixtures: LIST_OF_THREE });
    const rendered = await openApp();
    await select(1);
    await press(within(await openExport("Export 1 selected bookmark")).getByRole("button", { name: "Export" }));
    await waitFor(() => {
      expect(exportsSent()).toHaveLength(1);
    });

    rendered.unmount();
    await act(async () => {
      release();
      await held;
    });

    expect(world.clicks).toEqual([]);
    expect(world.created).toEqual([]);
  });

  it("is offered where the selection holds a shared bookmark, which only the readable fields of are exported, while the actions that change bookmarks stay off", async () => {
    serve({ fixtures: { listBookmarks: page([bookmark(1), bookmark(2), shared(3)]) } });
    await openApp();
    await select(1, 3);

    expect(within(bar()).getByText(/1 shared bookmark is selected, so only Open all and Export selection are available\./)).toBeDefined();
    const dialog = await openExport("Export 2 selected bookmarks");
    within(dialog).getByText(/shared with you are exported as their readable fields only/);
    await press(within(dialog).getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    expect(exportsSent()[0]?.params.getAll("id")).toEqual([idOf(1), idOf(3)]);
    expect(within(bar()).getByRole("button", { name: "Pin" }).hasAttribute("disabled")).toBe(true);
  });

  it("closes the question without exporting when it is cancelled", async () => {
    serve({ fixtures: LIST_OF_THREE });
    await openApp();
    await select(1, 2);

    const dialog = await openExport("Export 2 selected bookmarks");
    await press(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(exportsSent()).toEqual([]);
    expect(within(bar()).getByText("2 selected")).toBeDefined();
  });
});

describe("exporting what Select all matching selected", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("names the filters of the list, with their scope, when more than 100 bookmarks are selected, and not their identifiers", async () => {
    world.count = () => "150";
    serve({ fixtures: { listBookmarks: page([bookmark(1), bookmark(2)], 150), listBookmarkIds: { ids: idsOf(150), truncated: false } } });
    await openApp("/bookmarks?pinned=true&q=docs");
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Select all 150 matching" }));
    await waitFor(() => {
      expect(within(bar()).getByText("150 selected")).toBeDefined();
    });

    await press(within(await openExport("Export 150 selected bookmarks")).getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    const [sent] = exportsSent();
    expect(exportsSent()).toHaveLength(1);
    expect(sent?.params.getAll("id")).toEqual([]);
    expect(Object.fromEntries(sent?.params.entries() ?? [])).toEqual({ scope: "all", pinned: "true", q: "docs" });
    expect((await screen.findAllByText("150 bookmarks exported")).length).toBeGreaterThan(0);
  });

  it("names the scope and the flags of the address in the filters", async () => {
    serve({ fixtures: { listBookmarks: page([bookmark(1)], 120), listBookmarkIds: { ids: idsOf(120), truncated: false } } });
    await openApp("/bookmarks?scope=mine&hasSlug=true&forwarding=true");
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Select all 120 matching" }));
    await waitFor(() => {
      expect(within(bar()).getByText("120 selected")).toBeDefined();
    });

    await press(within(await openExport("Export 120 selected bookmarks")).getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(exportsSent()).toHaveLength(1);
    });
    expect(Object.fromEntries(exportsSent()[0]?.params.entries() ?? [])).toEqual({ scope: "mine", hasSlug: "true", forwarding: "true" });
  });

  it("sends the identifiers, not the filters, when select-all found 100 or fewer", async () => {
    serve({ fixtures: { listBookmarks: page([bookmark(1)], 100), listBookmarkIds: { ids: idsOf(100), truncated: false } } });
    await openApp("/bookmarks?pinned=true");
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Select all 100 matching" }));
    await waitFor(() => {
      expect(within(bar()).getByText("100 selected")).toBeDefined();
    });

    await press(within(await openExport("Export 100 selected bookmarks")).getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(exportsSent()).toHaveLength(1);
    });
    expect(exportsSent()[0]?.params.getAll("id")).toEqual(idsOf(100));
    expect(exportsSent()[0]?.params.get("pinned")).toBeNull();
  });

  it("is not offered for more than 100 selected bookmarks that are not what the filters match, and says why", async () => {
    serve({ fixtures: { listBookmarks: page([bookmark(1), bookmark(2)], 150), listBookmarkIds: { ids: idsOf(150), truncated: false } } });
    await openApp();
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Select all 150 matching" }));
    await waitFor(() => {
      expect(within(bar()).getByText("150 selected")).toBeDefined();
    });
    expect(within(bar()).getByRole("button", { name: "Export selection" }).hasAttribute("disabled")).toBe(false);

    // Taking one bookmark out leaves 149, which no filter names.
    await press(checkbox(2));

    await waitFor(() => {
      expect(within(bar()).getByText("149 selected")).toBeDefined();
    });
    const action = within(bar()).getByRole("button", { name: "Export selection" });
    expect(action.hasAttribute("disabled")).toBe(true);
    // The reason names a control that is there: Select all matching is offered for the selection that is one short of it.
    expect(within(bar()).getByRole("button", { name: "Select all 150 matching" })).toBeDefined();
    await act(async () => {
      fireEvent.focus(action.parentElement as HTMLElement);
      await Promise.resolve();
    });
    expect((await screen.findByText(/or use Select all matching to export every bookmark that matches/)).textContent).toContain("at most 100 selected bookmarks");
    await press(action);
    expect(screen.queryByRole("dialog", { name: /^Export/ })).toBeNull();
    expect(exportsSent()).toEqual([]);
  });

  it("exports by the filters when Shift A selected every match of a list that holds all of them, though no Select all matching is offered", async () => {
    world.count = () => "120";
    const all = Array.from({ length: 120 }, (_, index) => bookmark(index + 1));
    serve({ fixtures: { listBookmarks: page(all, 120) } });
    await openApp("/bookmarks?pinned=true");
    await key({ key: "A", shiftKey: true });
    await waitFor(() => {
      expect(within(bar()).getByText("120 selected")).toBeDefined();
    });
    expect(within(bar()).queryByRole("button", { name: /Select all/ })).toBeNull();

    await press(within(await openExport("Export 120 selected bookmarks")).getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(world.clicks).toHaveLength(1);
    });
    expect(exportsSent()).toHaveLength(1);
    expect(exportsSent()[0]?.params.getAll("id")).toEqual([]);
    expect(Object.fromEntries(exportsSent()[0]?.params.entries() ?? [])).toEqual({ scope: "all", pinned: "true" });
    expect((await screen.findAllByText("120 bookmarks exported")).length).toBeGreaterThan(0);
  });

  it("still cannot export 119 of the 120 loaded matches, and the control its reason names is there", async () => {
    const all = Array.from({ length: 120 }, (_, index) => bookmark(index + 1));
    serve({ fixtures: { listBookmarks: page(all, 120) } });
    await openApp();
    await key({ key: "A", shiftKey: true });
    await waitFor(() => {
      expect(within(bar()).getByText("120 selected")).toBeDefined();
    });
    await press(checkbox(7));

    await waitFor(() => {
      expect(within(bar()).getByText("119 selected")).toBeDefined();
    });
    expect(within(bar()).getByRole("button", { name: "Export selection" }).hasAttribute("disabled")).toBe(true);
    expect(within(bar()).getByRole("button", { name: "Select all 120 matching" })).toBeDefined();
    expect(exportsSent()).toEqual([]);
  });

  it("says the selection follows the filters in the dialog of an export by the filters, and not in the dialog of one by identifiers", async () => {
    const all = Array.from({ length: 120 }, (_, index) => bookmark(index + 1));
    serve({ fixtures: { listBookmarks: page(all, 120) } });
    await openApp();
    await select(1);
    const named = await openExport("Export 1 selected bookmark");
    expect(within(named).queryByText(/follows the current filters/)).toBeNull();
    await press(within(named).getByRole("button", { name: "Cancel" }));
    await key({ key: "A", shiftKey: true });
    await waitFor(() => {
      expect(within(bar()).getByText("120 selected")).toBeDefined();
    });

    const byFilters = await openExport("Export 120 selected bookmarks");

    within(byFilters).getByText(/The selection follows the current filters: the file holds every bookmark that matches when the export runs/);
  });

  it.each([
    ["150", "150 bookmarks exported", null],
    ["151", "151 bookmarks exported, but 150 were selected. The list changed since you selected.", "150 bookmarks exported"],
    ["149", "149 bookmarks exported, but 150 were selected. The list changed since you selected.", "150 bookmarks exported"],
    ["1", "1 bookmark exported, but 150 were selected. The list changed since you selected.", "150 bookmarks exported"],
  ])("states the count %s of the file, and both numbers when it is not the number selected", async (count, toast, absent) => {
    world.count = () => count;
    serve({ fixtures: { listBookmarks: page([bookmark(1), bookmark(2)], 150), listBookmarkIds: { ids: idsOf(150), truncated: false } } });
    await openApp();
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Select all 150 matching" }));
    await waitFor(() => {
      expect(within(bar()).getByText("150 selected")).toBeDefined();
    });

    await press(within(await openExport("Export 150 selected bookmarks")).getByRole("button", { name: "Export" }));

    expect((await screen.findAllByText(toast)).length).toBeGreaterThan(0);
    expect(world.clicks).toHaveLength(1);
    if (absent !== null) {
      expect(screen.queryByText(absent)).toBeNull();
    }
    expect(within(bar()).getByText("150 selected")).toBeDefined();
  });

  it("does not offer an export by the filters for the 120 loaded matches of 150, though all 120 are selected", async () => {
    const loaded = Array.from({ length: 120 }, (_, index) => bookmark(index + 1));
    serve({ fixtures: { listBookmarks: page(loaded, 150) } });
    await openApp();
    await key({ key: "A", shiftKey: true });
    await waitFor(() => {
      expect(within(bar()).getByText("120 selected")).toBeDefined();
    });

    // The filters name 150 bookmarks, so exporting by them would not export what is selected.
    expect(within(bar()).getByRole("button", { name: "Export selection" }).hasAttribute("disabled")).toBe(true);
    expect(within(bar()).getByRole("button", { name: "Select all 150 matching" })).toBeDefined();
    expect(exportsSent()).toEqual([]);
  });

  it("does not offer an export by the filters for 120 selected bookmarks that are not the 120 loaded matches, says to deselect some, and keeps the note of the shared bookmark to Open all", async () => {
    const loaded = Array.from({ length: 120 }, (_, index) => (index === 1 ? shared(2) : bookmark(index + 1)));
    // The select-all found a bookmark the list has not loaded, in place of the loaded 120th.
    serve({ fixtures: { listBookmarks: page(loaded, 120), listBookmarkIds: { ids: [...idsOf(119), idOf(500)], truncated: false } } });
    await openApp();
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Select all 120 matching" }));
    await waitFor(() => {
      expect(within(bar()).getByText("120 selected")).toBeDefined();
    });
    // Taking Bookmark 1 out and putting Bookmark 120 in leaves 120 of them, as many as are loaded and match, but not those.
    await press(checkbox(1));
    await press(checkbox(120));
    await waitFor(() => {
      expect(within(bar()).getByText("120 selected")).toBeDefined();
    });
    expect(checkbox(120).getAttribute("aria-checked")).toBe("true");
    expect(checkbox(1).getAttribute("aria-checked")).toBe("false");

    const action = within(bar()).getByRole("button", { name: "Export selection" });
    expect(action.hasAttribute("disabled")).toBe(true);
    // No Select all matching is shown, so the reason does not send the member to it.
    expect(within(bar()).queryByRole("button", { name: /Select all/ })).toBeNull();
    await act(async () => {
      fireEvent.focus(action.parentElement as HTMLElement);
      await Promise.resolve();
    });
    expect((await screen.findByText("An export takes at most 100 selected bookmarks. Deselect some to export them.")).textContent).not.toContain("Select all matching");
    // Export is not offered, so the note on the shared bookmark does not name it.
    expect(within(bar()).getByText(/shared bookmarks? (is|are) selected, so only Open all is available\./)).toBeDefined();
    expect(within(bar()).queryByText(/Export selection are available/)).toBeNull();
    expect(exportsSent()).toEqual([]);
  });

  it("is not offered when more bookmarks match than the cap, since the capped set is not what the filters match", async () => {
    serve({ fixtures: { listBookmarks: page([bookmark(1)], 6200), listBookmarkIds: { ids: idsOf(5000), truncated: true } } });
    await openApp();
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Select the first 5,000 of 6,200 matching" }));
    await waitFor(() => {
      expect(within(bar()).getByText("5,000 selected")).toBeDefined();
    });

    const action = within(bar()).getByRole("button", { name: "Export selection" });
    expect(action.hasAttribute("disabled")).toBe(true);
    await press(action);
    expect(screen.queryByRole("dialog", { name: /^Export/ })).toBeNull();
    expect(exportsSent()).toEqual([]);
  });
});
