import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The text search of the bookmark list and of the Forwarding slugs (doc 02 sections 5.7 and 9.1, doc 03 sections 3.1, 3.5 and 8) through the app's own API client, against a stubbed
// transport that filters the bookmarks by the text the way the API does: by the start of a word of the title, host, slug and description. The failure scenarios are a request made for
// each key instead of the text after the member pauses, a text that does not reach the address or the request (or an address that does not reach the field), a chip or the clear
// button that leaves the old text in the field, a skeleton or the empty state missing while the matches are read, a "select all matching" that names bookmarks the text hides, and a text rendered as markup.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Transport = (request: Request) => Promise<Response>;

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const BOOKMARKS = "/api/v1/bookmarks";
const IDLE_MS = 150;

function bookmarkOf(n: number, overrides: Partial<Bookmark> = {}): Bookmark {
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
    lastOpenedAt: null,
    folders: [],
    tags: [],
    version: 1,
    createdAt: `2026-10-01T08:${String(n).padStart(2, "0")}:00.000Z`,
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly at: number;
}

interface Server {
  readonly calls: Call[];
  /** The reads of the bookmark list, in the order they were made. */
  readonly lists: () => Call[];
  /** Holds the answer to the next reads of the list, which have `q`, until released. */
  readonly hold: () => () => void;
}

/** A signed-in server with the bookmarks of the member, which a list read narrows by `hasSlug`, `scope` and `q`. */
function stubServer(all: readonly Bookmark[]): Server {
  const calls: Call[] = [];
  let held: Promise<void> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) =>
      signedIn(request, async (other) => {
        const url = new URL(other.url);
        const call: Call = { method: other.method, path: url.pathname, params: url.searchParams, at: performance.now() };
        if (url.pathname === "/api/v1/folders" || url.pathname === "/api/v1/tags") {
          return json({ items: [], nextCursor: null, total: 0 });
        }
        calls.push(call);
        const matching = (): Bookmark[] => {
          const text = url.searchParams.get("q")?.toLowerCase();
          return all
            .filter((bookmark) => (url.searchParams.get("hasSlug") === "true" ? bookmark.slug !== null : true))
            .filter((bookmark) => text === undefined || [bookmark.title, bookmark.host, bookmark.slug ?? "", bookmark.description ?? ""].some((field) => field.toLowerCase().split(/[^a-z0-9]+/).some((word) => word.startsWith(text))))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        };
        if (url.pathname === BOOKMARKS && other.method === "GET") {
          if (url.searchParams.has("q")) {
            await held;
          }
          const items = matching();
          return json({ items, nextCursor: null, total: items.length });
        }
        if (url.pathname === `${BOOKMARKS}/ids` && other.method === "GET") {
          return json({ ids: matching().map((bookmark) => bookmark.id), truncated: false });
        }
        return json({ type: "about:blank", title: "Not found", status: 404, code: "not_found" }, { status: 404, contentType: "application/problem+json" });
      }),
    ),
  );
  return {
    calls,
    lists: () => calls.filter((call) => call.method === "GET" && call.path === BOOKMARKS),
    hold: () => {
      let release: () => void = () => undefined;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        held = undefined;
      };
    },
  };
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
});

afterAll(() => {
  restoreWait();
});

beforeEach(() => {
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

async function type(field: HTMLElement, text: string): Promise<number> {
  await act(async () => {
    fireEvent.change(field, { target: { value: text } });
    await Promise.resolve();
  });
  return performance.now();
}

const WORLD = [
  bookmarkOf(1, { title: "Widget notes", slug: "widgets", forwarding: true }),
  bookmarkOf(2, { title: "Gadget notes", host: "gadgets.example.com" }),
  bookmarkOf(3, { title: "Widget manual", description: "all about gadgets" }),
  bookmarkOf(4, { title: "Cooking", slug: "cook" }),
];

describe("the search field of the bookmark list", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("writes the text to the address and asks for it once the member has paused for 150 ms, not for each key, and shows the narrowed list with a chip", async () => {
    const server = stubServer(WORLD);
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Cooking" });
    const field = screen.getByRole("searchbox", { name: "Search" });
    const before = server.lists().length;

    await type(field, "w");
    const typedAt = await type(field, "widg");

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Cooking" })).toBeNull();
    });
    await screen.findByRole("link", { name: "Widget notes" });
    const asked = server.lists().slice(before);
    expect(asked.map((call) => call.params.get("q"))).toEqual(["widg"]);
    expect(asked[0]?.at ?? 0).toBeGreaterThanOrEqual(typedAt + IDLE_MS - 20);
    expect(window.location.search).toBe("?q=widg");
    const chips = screen.getByRole("list", { name: "Active filters" });
    expect(within(chips).getByText("Search: widg")).toBeDefined();
  });

  it("reads the text of the address into the field, the request and a chip, and keeps the sort and the other filters", async () => {
    const server = stubServer(WORLD);
    await openApp("/bookmarks?q=gadgets&sort=title_asc&hasSlug=true");

    await screen.findByText("No bookmarks match these filters");

    expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Search" }).value).toBe("gadgets");
    const last = server.lists().at(-1);
    expect(last?.params.get("q")).toBe("gadgets");
    expect(last?.params.get("sort")).toBe("title_asc");
    expect(last?.params.get("hasSlug")).toBe("true");
    expect(within(screen.getByRole("list", { name: "Active filters" })).getByText("Search: gadgets")).toBeDefined();
  });

  it("reads the text of an address that the router read as a number as the text", async () => {
    const server = stubServer([bookmarkOf(1, { title: "Route 66" })]);
    await openApp("/bookmarks?q=66");

    await screen.findByRole("link", { name: "Route 66" });

    expect(server.lists().at(-1)?.params.get("q")).toBe("66");
    expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Search" }).value).toBe("66");
  });

  it("matches the text in the host, the slug and the description as well as the title", async () => {
    stubServer(WORLD);
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Cooking" });
    const field = screen.getByRole("searchbox", { name: "Search" });

    await type(field, "gadget");

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Cooking" })).toBeNull();
    });
    await screen.findByRole("link", { name: "Gadget notes" });
    expect(screen.getByRole("link", { name: "Widget manual" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Cooking" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Widget notes" })).toBeNull();
  });

  it("takes the text off with the chip, which empties the field and the address, and with Clear filters", async () => {
    const server = stubServer(WORLD);
    await openApp("/bookmarks?q=widget&sort=oldest");
    await screen.findByRole("link", { name: "Widget notes" });

    await press(screen.getByRole("button", { name: "Remove filter: Search: widget" }));

    await screen.findByRole("link", { name: "Cooking" });
    expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Search" }).value).toBe("");
    expect(window.location.search).toBe("?sort=oldest");
    expect(server.lists().at(-1)?.params.has("q")).toBe(false);

    await type(screen.getByRole("searchbox", { name: "Search" }), "cook");
    await screen.findByText("Search: cook");
    await press(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Search" }).value).toBe("");
    });
    expect(window.location.search).toBe("?sort=oldest");
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
  });

  it("shows the field's own text until the member pauses, whatever the address says, and does not take the whitespace they typed away", async () => {
    stubServer(WORLD);
    await openApp("/bookmarks?q=widget");
    await screen.findByRole("link", { name: "Widget notes" });
    const field = screen.getByRole<HTMLInputElement>("searchbox", { name: "Search" });

    await type(field, "widget ");
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS + 100));

    expect(field.value).toBe("widget ");
    expect(window.location.search).toBe("?q=widget");
  });

  it("says the matches are loading while it asks for them, and that none match with a button that clears the text", async () => {
    const server = stubServer(WORLD);
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Cooking" });
    const release = server.hold();

    await type(screen.getByRole("searchbox", { name: "Search" }), "zzzz");

    await screen.findByRole("status", { name: "Loading the bookmarks" });
    expect(screen.queryByRole("link", { name: "Cooking" })).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeDefined();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await screen.findByText("No bookmarks match these filters");
    expect(screen.queryByRole("status", { name: "Loading the bookmarks" })).toBeNull();

    // The toolbar has the button too; the empty state's is the last.
    const clearing = screen.getAllByRole("button", { name: "Clear filters" });
    expect(clearing).toHaveLength(2);
    await press(clearing.at(-1) as HTMLElement);

    await screen.findByRole("link", { name: "Cooking" });
    expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Search" }).value).toBe("");
    expect(window.location.search).toBe("");
  });

  it("names the text in the request that selects every matching bookmark, so the selection holds the matches and no other", async () => {
    const server = stubServer(WORLD);
    await openApp("/bookmarks?q=widget");
    await screen.findByRole("link", { name: "Widget notes" });
    const first = screen.getByRole("link", { name: "Widget notes" }).closest("[data-item-id]");
    expect(first).not.toBeNull();
    await press(within(first as HTMLElement).getByRole("checkbox", { name: "Select Widget notes" }));

    await press(await screen.findByRole("button", { name: "Select all 2 matching" }));

    expect(await screen.findByText("2 selected")).toBeDefined();
    const asked = server.calls.filter((call) => call.method === "GET" && call.path === `${BOOKMARKS}/ids`);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.params.get("q")).toBe("widget");
  });

  it("shows a text as text, never as markup", async () => {
    stubServer(WORLD);
    await openApp(`/bookmarks?q=${encodeURIComponent("<img src=x onerror=alert(1)>")}`);

    await screen.findByText("No bookmarks match these filters");

    expect(within(screen.getByRole("list", { name: "Active filters" })).getByText("Search: <img src=x onerror=alert(1)>")).toBeDefined();
    expect(document.querySelector("img[src='x']")).toBeNull();
  });
});

describe("the search field of the Forwarding slugs", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks for the slugs the text matches, with the slugs filter kept, after the member pauses, and leaves the address alone", async () => {
    const server = stubServer(WORLD);
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Your slugs" });
    const field = screen.getByRole("searchbox", { name: "Search your slugs" });
    const before = server.lists().length;

    await type(field, "w");
    await type(field, "widg");

    await waitFor(() => {
      expect(server.lists().at(-1)?.params.get("q")).toBe("widg");
    });
    expect(server.lists().slice(before).map((call) => call.params.get("q"))).toEqual(["widg"]);
    expect(server.lists().at(-1)?.params.get("hasSlug")).toBe("true");
    expect(server.lists().at(-1)?.params.get("scope")).toBe("mine");
    expect(window.location.search).toBe("");
    await waitFor(() => {
      expect(within(screen.getByRole("table", { name: "Your slugs" })).queryByText("/go/cook")).toBeNull();
    });
    expect(within(screen.getByRole("table", { name: "Your slugs" })).getByText("/go/widgets")).toBeDefined();
  });

  it("says none match, with a button that clears the search and shows the slugs again, and not that there are no slugs yet", async () => {
    stubServer(WORLD);
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Your slugs" });

    await type(screen.getByRole("searchbox", { name: "Search your slugs" }), "zzzz");

    await screen.findByRole("heading", { level: 3, name: "No slugs match this search" });
    expect(screen.queryByRole("heading", { level: 3, name: "No slugs yet" })).toBeNull();

    await press(screen.getByRole("button", { name: "Clear search" }));

    await screen.findByRole("table", { name: "Your slugs" });
    expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Search your slugs" }).value).toBe("");
  });
});
