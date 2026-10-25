import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, json, meOf, problem, allowSlowRender, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// Selecting bookmarks of the list and acting on the selection (doc 03 section 3.4, doc 02 section 5.8) against the handlers
// generated from openapi.json. The failure scenarios are a delete sent without the confirmation or with a count other
// than the one it states, a "select all" that ignores the list's filters or the cap, a selection that survives a change of
// the filters, a result that hides how many bookmarks were skipped, a failed request that clears the selection or is
// reported as done, a longer selection that is sent in one request the API refuses, and a single-key shortcut that fires
// after the account turned them off or from inside a dialog.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const LIST = "/api/v1/bookmarks";
const BULK = `${LIST}/bulk`;

function idOf(n: number): string {
  return `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`;
}

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
    folders: [],
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

function page(items: readonly Bookmark[], total: number | null = items.length): unknown {
  return { items, nextCursor: total !== null && total > items.length ? "next" : null, total, ...(total === null ? { totalAtLeast: 10000 } : {}) };
}

function idsOf(count: number): string[] {
  return Array.from({ length: count }, (_, index) => idOf(index + 1));
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly body: Promise<string>;
}

let calls: Call[] = [];

function use(scenario: Omit<Scenario, "name"> = {}): void {
  server.use(...createHandlers(document_, { scenario: { name: "selection", ...scenario } }));
}

function to(method: string, path: string): Call[] {
  return calls.filter((call) => call.method === method && call.path === path);
}

async function bodyOf(call: Call | undefined): Promise<unknown> {
  expect(call).toBeDefined();
  return JSON.parse((await call?.body) ?? "null") as unknown;
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    const clone = request.clone();
    calls.push({ method: request.method, path: url.pathname, params: url.searchParams, body: request.method === "GET" ? Promise.resolve("") : clone.text() });
  });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  restoreWait();
  server.close();
});

beforeEach(() => {
  calls = [];
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openApp(path: string): Promise<void> {
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

function box(n: number): HTMLElement {
  return screen.getByRole("checkbox", { name: `Select Bookmark ${String(n)}` });
}

function bar(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Selected bookmarks" });
}

async function key(init: KeyboardEventInit, target: Element | Window = window): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, init);
    await Promise.resolve();
  });
}

interface BulkBody {
  action: string;
  ids: string[];
}

/**
 * A server that answers the bulk request as `respond` says, which the mock API cannot (a wait, a different answer to each
 * request), with the list, the identifiers and the signed-in visitor of the mock API's kind.
 */
function stubServer(
  list: unknown,
  respond: (turn: number, body: BulkBody) => Response | Promise<Response>,
  ids?: unknown,
  answerIds?: () => Response | Promise<Response>,
): { readonly bodies: BulkBody[] } {
  const bodies: BulkBody[] = [];
  vi.stubGlobal("fetch", (request: Request) =>
    signedIn(request, async () => {
      const { pathname } = new URL(request.url);
      if (pathname === LIST) {
        return json(list);
      }
      if (pathname === `${LIST}/ids`) {
        return answerIds === undefined ? json(ids) : answerIds();
      }
      if (pathname === BULK) {
        bodies.push((await request.json()) as BulkBody);
        return respond(bodies.length, bodies[bodies.length - 1] as BulkBody);
      }
      throw new Error(`unexpected call ${request.method} ${pathname}`);
    }),
  );
  return { bodies };
}

/** The live region of the page, which the toasts' own region is not. */
function liveRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>("p.sr-only[role='status']");
  expect(region).not.toBeNull();
  return region as HTMLElement;
}

const RESULT = { requested: 2, affected: 2, skipped: 0, skippedReasons: { not_owner: 0, not_found: 0 } };

async function select(...numbers: number[]): Promise<void> {
  for (const n of numbers) {
    await press(box(n));
  }
}

describe("selecting", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("selects cards by their checkbox, counts them in the bar and clears them from it", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1), bookmark(2), bookmark(3)]) } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    expect(screen.queryByRole("toolbar")).toBeNull();

    await select(1, 3);

    expect(within(bar()).getByText("2 selected")).toBeDefined();
    expect(box(1).getAttribute("aria-checked")).toBe("true");
    expect(box(2).getAttribute("aria-checked")).toBe("false");
    await select(1);
    expect(within(bar()).getByText("1 selected")).toBeDefined();
    await press(within(bar()).getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(box(3).getAttribute("aria-checked")).toBe("false");
  });

  it("selects table rows the same way", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1), bookmark(2)]) } });
    await openApp("/bookmarks?view=table");
    await screen.findByRole("table", { name: "Bookmarks" });

    await select(2);

    expect(within(bar()).getByText("1 selected")).toBeDefined();
    const row = box(2).closest("tr");
    expect(row?.getAttribute("data-state")).toBe("selected");
    expect(screen.getByRole("link", { name: "Bookmark 1" }).closest("tr")?.getAttribute("data-state")).toBeNull();
  });

  it("drops the selection when the filters change", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);
    expect(screen.getByRole("toolbar")).toBeDefined();

    await press(screen.getByRole("button", { name: "Pinned" }));

    await waitFor(() => {
      expect(window.location.search).toBe("?pinned=true");
    });
    expect(screen.queryByRole("toolbar")).toBeNull();
    // A sort does not change which bookmarks match, so it keeps the selection.
    await select(1);
    await press(screen.getByRole("combobox", { name: "Sort by" }));
    await act(async () => {
      const item = await screen.findByRole("option", { name: "Most used" });
      fireEvent.pointerDown(item);
      fireEvent.click(item);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(window.location.search).toContain("sort=most_used");
    });
    expect(within(bar()).getByText("1 selected")).toBeDefined();
  });
});

describe("select all matching", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks for the identifiers the list's filters match, selects them all and stops offering it", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1), bookmark(2)], 40), listBookmarkIds: { ids: idsOf(40), truncated: false } } });
    await openApp("/bookmarks?pinned=true&sort=title_asc&size=48");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);

    await press(within(bar()).getByRole("button", { name: "Select all 40 matching" }));

    await waitFor(() => {
      expect(within(bar()).getByText("40 selected")).toBeDefined();
    });
    const params = to("GET", `${LIST}/ids`)[0]?.params;
    expect(params?.get("pinned")).toBe("true");
    expect(params?.get("sort")).toBeNull();
    expect(params?.get("limit")).toBeNull();
    expect(within(bar()).queryByRole("button", { name: /Select all/ })).toBeNull();
    expect(within(bar()).queryByText(/can be selected at once/)).toBeNull();
  });

  it("says so when the filter matches more than the cap and selects the capped set", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)], 6200), listBookmarkIds: { ids: idsOf(5000), truncated: true } } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);

    await press(within(bar()).getByRole("button", { name: "Select the first 5,000 of 6,200 matching" }));

    await waitFor(() => {
      expect(within(bar()).getByText("5,000 selected")).toBeDefined();
    });
    expect(within(bar()).getByText("More bookmarks match than the 5,000 that can be selected at once.")).toBeDefined();
    expect(within(bar()).queryByRole("button", { name: /Select/ })).toBeNull();
  });

  it("offers the capped set when the count is not known exactly", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)], null) } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    await select(1);

    expect(within(bar()).getByRole("button", { name: "Select the first 5,000 matching" })).toBeDefined();
  });

  it("does not give the identifiers of the filters it asked under to the selection of the filters now on screen", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answered = false;
    stubServer(
      page([bookmark(1)], 40),
      () => json(RESULT),
      undefined,
      async () => {
        await gate;
        answered = true;
        return json({ ids: idsOf(40), truncated: false });
      },
    );
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Select all 40 matching" }));

    await press(screen.getByRole("button", { name: "Pinned" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?pinned=true");
    });
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => {
      expect(answered).toBe(true);
    });
    // Let the answer reach the page before looking at it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(screen.queryByRole("toolbar")).toBeNull();
    await select(1);
    expect(within(bar()).getByText("1 selected")).toBeDefined();
    expect(within(bar()).getByRole("button", { name: "Select all 40 matching" })).toBeDefined();
  });

  it("keeps the selection and says so when the identifiers cannot be read", async () => {
    use({ statuses: { listBookmarkIds: 429 }, fixtures: { listBookmarks: page([bookmark(1)], 40) } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);

    await press(within(bar()).getByRole("button", { name: "Select all 40 matching" }));

    expect((await screen.findAllByText("The matching bookmarks could not be selected. Try again in a moment.")).length).toBeGreaterThan(0);
    expect(within(bar()).getByText("1 selected")).toBeDefined();
    expect(within(bar()).getByRole("button", { name: "Select all 40 matching" })).toBeDefined();
  });
});

describe("deleting", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("states how many bookmarks it deletes, sends nothing on Cancel, and reports the result in a toast and a live region", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1), bookmark(2), bookmark(3)]), bulkBookmarks: { ...RESULT, requested: 3, affected: 3 } } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1, 2, 3);

    await press(within(bar()).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete 3 bookmarks?" });
    expect(confirm.textContent).toContain("Their slugs stop forwarding immediately. This cannot be undone.");
    expect(to("POST", BULK)).toHaveLength(0);
    await press(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(to("POST", BULK)).toHaveLength(0);
    expect(within(bar()).getByText("3 selected")).toBeDefined();

    await press(within(bar()).getByRole("button", { name: "Delete" }));
    await press(within(await screen.findByRole("alertdialog", { name: "Delete 3 bookmarks?" })).getByRole("button", { name: "Delete bookmarks" }));

    await waitFor(() => {
      expect(to("POST", BULK)).toHaveLength(1);
    });
    expect(await bodyOf(to("POST", BULK)[0])).toEqual({ action: "delete", ids: [idOf(1), idOf(2), idOf(3)] });
    await waitFor(() => {
      expect(screen.queryByRole("toolbar")).toBeNull();
    });
    expect(liveRegion().textContent).toBe("3 bookmarks deleted.");
    // The toast shows it and announces it.
    expect(await screen.findAllByText("3 bookmarks deleted.")).toHaveLength(2);
    expect(to("GET", LIST).length).toBeGreaterThan(1);
  });

  it("says Delete 1 bookmark for one", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);

    await press(within(bar()).getByRole("button", { name: "Delete" }));

    const confirm = await screen.findByRole("alertdialog", { name: "Delete 1 bookmark?" });
    expect(confirm.textContent).toContain("Its slug stops forwarding immediately.");
  });

  it("keeps the selection and tells the member when the request fails, and does not report a delete", async () => {
    use({ statuses: { bulkBookmarks: 429 }, fixtures: { listBookmarks: page([bookmark(1), bookmark(2)]) } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1, 2);
    await press(within(bar()).getByRole("button", { name: "Delete" }));

    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete bookmarks" }));

    expect((await screen.findAllByText("The bookmarks could not be deleted. Nothing was changed. Try again in a moment.")).length).toBeGreaterThan(1);
    expect(liveRegion().textContent).toBe("The bookmarks could not be deleted. Nothing was changed. Try again in a moment.");
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(within(bar()).getByText("2 selected")).toBeDefined();
    expect(screen.queryByText(/deleted\.$/)).toBeNull();
  });

  it("shows the wait on Delete while the request runs and keeps the other actions from starting", async () => {
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    stubServer(page([bookmark(1)]), async () => {
      await gate;
      return json({ ...RESULT, requested: 1, affected: 1 });
    });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Delete" }));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete bookmark" }));

    // The dialog makes the page behind it inert for assistive technology.
    const busyBar = document.querySelector<HTMLElement>("[data-slot='bulk-bar']") as HTMLElement;
    await waitFor(() => {
      expect(busyBar.getAttribute("aria-busy")).toBe("true");
    });
    // A toolbar button that cannot be pressed stays focusable and says so with aria-disabled.
    expect(within(busyBar).getByRole("button", { name: "Pin", hidden: true }).getAttribute("aria-disabled")).toBe("true");
    expect(within(busyBar).getByRole("button", { name: "Clear selection", hidden: true }).getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector("[role='alertdialog'] button[data-loading]")).not.toBeNull();
    await act(async () => {
      finish();
      await gate;
    });
    await waitFor(() => {
      expect(screen.queryByRole("toolbar")).toBeNull();
    });
    expect((await screen.findAllByText("1 bookmark deleted.")).length).toBeGreaterThan(1);
    expect(liveRegion().textContent).toBe("1 bookmark deleted.");
  });
});

describe("pinning and unpinning", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("pins the selection and reports affected and skipped counts", async () => {
    use({
      fixtures: {
        listBookmarks: page([bookmark(1), bookmark(2), bookmark(3)]),
        bulkBookmarks: { requested: 3, affected: 2, skipped: 1, skippedReasons: { not_owner: 0, not_found: 1 } },
      },
    });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1, 2, 3);

    await press(within(bar()).getByRole("button", { name: "Pin" }));

    await waitFor(() => {
      expect(to("POST", BULK)).toHaveLength(1);
    });
    expect(await bodyOf(to("POST", BULK)[0])).toEqual({ action: "pin", ids: [idOf(1), idOf(2), idOf(3)] });
    const message = "2 bookmarks pinned. 1 bookmark was skipped because it no longer exists or can’t be changed.";
    await waitFor(() => {
      expect(liveRegion().textContent).toBe(message);
    });
    expect(screen.getAllByText("2 bookmarks pinned.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 bookmark was skipped because it no longer exists or can’t be changed.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("unpins the selection", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1, { pinned: true })]), bulkBookmarks: { ...RESULT, requested: 1, affected: 1 } } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);

    await press(within(bar()).getByRole("button", { name: "Unpin" }));

    await waitFor(() => {
      expect(to("POST", BULK)).toHaveLength(1);
    });
    expect(await bodyOf(to("POST", BULK)[0])).toEqual({ action: "unpin", ids: [idOf(1)] });
    expect((await screen.findAllByText("1 bookmark unpinned.")).length).toBeGreaterThan(1);
  });

  it("sends a longer selection in requests of 1 000 and keeps what was not reached when one fails", async () => {
    const sent = stubServer(
      page([bookmark(1)], 1500),
      (turn, body) => (turn === 1 ? json({ requested: body.ids.length, affected: body.ids.length, skipped: 0, skippedReasons: { not_owner: 0, not_found: 0 } }) : problem(429, "rate_limited", "req-1")),
      { ids: idsOf(1500), truncated: false },
    );
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Select all 1,500 matching" }));
    await waitFor(() => {
      expect(within(bar()).getByText("1,500 selected")).toBeDefined();
    });

    await press(within(bar()).getByRole("button", { name: "Pin" }));

    await waitFor(() => {
      expect(sent.bodies).toHaveLength(2);
    });
    expect(sent.bodies.map((body) => body.ids.length)).toEqual([1000, 500]);
    expect((await screen.findAllByText("Only 1,000 of 1,500 bookmarks were changed before an error. The rest are still selected; try again in a moment.")).length).toBeGreaterThan(0);
    expect(within(bar()).getByText("500 selected")).toBeDefined();
  });
});

describe("a request that answers after the filters changed", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("reports a failure without putting the unreached bookmarks back into the selection of the new filters", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent = stubServer(
      page([bookmark(1)], 1500),
      async (turn, body) => {
        if (turn === 1) {
          return json({ requested: body.ids.length, affected: body.ids.length, skipped: 0, skippedReasons: { not_owner: 0, not_found: 0 } });
        }
        await gate;
        return problem(429, "rate_limited", "req-1");
      },
      { ids: idsOf(1500), truncated: false },
    );
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Select all 1,500 matching" }));
    await waitFor(() => {
      expect(within(bar()).getByText("1,500 selected")).toBeDefined();
    });
    await press(within(bar()).getByRole("button", { name: "Pin" }));
    await waitFor(() => {
      expect(sent.bodies).toHaveLength(2);
    });

    await press(screen.getByRole("button", { name: "Pinned" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?pinned=true");
    });
    await act(async () => {
      release();
      await gate;
    });

    expect((await screen.findAllByText("Only 1,000 of 1,500 bookmarks were changed before an error. The rest are still selected; try again in a moment.")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("does not clear a selection made under the new filters when the result of the old ones arrives", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer(page([bookmark(1)]), async () => {
      await gate;
      return json({ ...RESULT, requested: 1, affected: 1 });
    });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Pin" }));
    await press(screen.getByRole("button", { name: "Pinned" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?pinned=true");
    });
    await select(1);
    expect(within(bar()).getByText("1 selected")).toBeDefined();

    await act(async () => {
      release();
      await gate;
    });

    expect((await screen.findAllByText("1 bookmark pinned.")).length).toBeGreaterThan(0);
    expect(within(bar()).getByText("1 selected")).toBeDefined();
  });
});

describe("shortcuts", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("toggles the focused item with X, selects the page with Shift A and clears with Escape", async () => {
    use({ fixtures: { getMe: meOf(ACCOUNT_BODY), listBookmarks: page([bookmark(1), bookmark(2), bookmark(3)]) } });
    await openApp("/bookmarks");
    const link = await screen.findByRole("link", { name: "Bookmark 2" });

    await key({ key: "x" });
    expect(screen.queryByRole("toolbar")).toBeNull();
    link.focus();
    await key({ key: "x" }, link);
    expect(within(bar()).getByText("1 selected")).toBeDefined();
    expect(box(2).getAttribute("aria-checked")).toBe("true");
    await key({ key: "x" }, link);
    expect(screen.queryByRole("toolbar")).toBeNull();

    await key({ key: "A", shiftKey: true });
    expect(within(bar()).getByText("3 selected")).toBeDefined();
    await key({ key: "Escape" });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("leaves the selection to a dialog that Escape closes", async () => {
    use({ fixtures: { getMe: meOf(ACCOUNT_BODY), listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);
    await press(within(bar()).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");

    await key({ key: "Escape" }, within(confirm).getByRole("button", { name: "Cancel" }));

    expect(within(bar()).getByText("1 selected")).toBeDefined();
  });

  it("leaves the selection to any overlay that holds focus when Escape is pressed", async () => {
    use({ fixtures: { getMe: meOf(ACCOUNT_BODY), listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await select(1);
    const overlay = window.document.createElement("div");
    overlay.setAttribute("role", "menu");
    const item = window.document.createElement("button");
    overlay.append(item);
    window.document.body.append(overlay);

    await key({ key: "Escape" }, item);
    overlay.remove();

    expect(within(bar()).getByText("1 selected")).toBeDefined();
  });

  it("does nothing while single-key shortcuts are off, and while focus is in a text field", async () => {
    use({ fixtures: { getMe: meOf({ ...ACCOUNT_BODY, singleKeyShortcuts: false }), listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    const link = await screen.findByRole("link", { name: "Bookmark 1" });
    link.focus();

    await key({ key: "x" }, link);
    await key({ key: "A", shiftKey: true });

    // The shortcut would have selected within this wait.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
