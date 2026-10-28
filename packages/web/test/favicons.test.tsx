import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, allowSlowRender, meOf, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The icons of the bookmark lists, the palette and Home (doc 02 section 5.4, doc 03 "Component system", doc 10 T14) against the handlers generated from
// openapi.json. The failure scenarios are a picture whose address is another origin, so the browser contacts a bookmarked site and the content security policy
// for images (`img-src 'self' data:`) would have to widen, a host that stands in the path unescaped, a bookmark without an icon that is drawn as an empty box,
// and an icon the server has none for (a one-pixel placeholder or a failed request) that is not replaced by the monogram.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type DashboardBookmark = ComponentTypes["schemas"]["DashboardBookmark"];
type SearchBookmark = ComponentTypes["schemas"]["SearchBookmark"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const OWNER = ACCOUNT_BODY.id;
const FAVICON_PATH = /^\/api\/v1\/favicons\/[a-z0-9.-]+$/;

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

function dashboardBookmark(n: number, overrides: Partial<DashboardBookmark> = {}): DashboardBookmark {
  return {
    id: `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`,
    title: `Bookmark ${String(n)}`,
    url: `https://site${String(n)}.example.com/page`,
    host: `site${String(n)}.example.com`,
    slug: null,
    forwarding: false,
    openCount: 0,
    ...overrides,
  };
}

function found(n: number): SearchBookmark {
  return {
    id: `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`,
    title: `Found ${String(n)}`,
    url: `https://found${String(n)}.example.org/`,
    host: `found${String(n)}.example.org`,
    slug: null,
    forwarding: false,
    pinned: false,
  };
}

function page(items: readonly Bookmark[]): unknown {
  return { items, nextCursor: null, total: items.length };
}

function use(fixtures: NonNullable<Scenario["fixtures"]>): void {
  server.use(...createResolverHandlers(document_, {}), ...createHandlers(document_, { scenario: { name: "favicons", fixtures: { getMe: meOf(ACCOUNT_BODY), ...fixtures } } }));
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
  server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => {
  restoreWait();
  server.close();
});

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

async function openApp(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("main", { hidden: true });
}

/** Every picture on the page: what the browser would request to draw it. */
function pictures(root: ParentNode = document): HTMLImageElement[] {
  return Array.from(root.querySelectorAll("img"));
}

/** The browser contacts no bookmarked site: every picture is on the app's own origin, at the favicon proxy, and nothing else loads an image. */
function expectOnlyOwnFavicons(root: ParentNode = document): string[] {
  const sources = pictures(root).map((img) => {
    expect(new URL(img.src, window.location.href).origin).toBe(window.location.origin);
    expect(img.getAttribute("src")).toMatch(FAVICON_PATH);
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("loading")).toBe("lazy");
    return img.getAttribute("src") ?? "";
  });
  expect(root.querySelectorAll("image, picture, source[srcset], [style*='url(']")).toHaveLength(0);
  return sources;
}

describe("the bookmark list", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  const bookmarks = [bookmark(1), bookmark(2, { host: "docs.example.org", url: "https://docs.example.org/" }), bookmark(3, { host: "xn--bcher-kva.example", url: "https://xn--bcher-kva.example/" })];

  it("draws a card with the icon of its host from the app's own origin", async () => {
    use({ listBookmarks: page(bookmarks) });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });

    expect(expectOnlyOwnFavicons(screen.getByRole("list", { name: "Bookmarks" }))).toEqual([
      "/api/v1/favicons/site1.example.com",
      "/api/v1/favicons/docs.example.org",
      "/api/v1/favicons/xn--bcher-kva.example",
    ]);
  });

  it("draws a row of the table the same way", async () => {
    use({ listBookmarks: page(bookmarks) });
    await openApp("/bookmarks?view=table");
    await screen.findByRole("link", { name: "Bookmark 1" });

    const table = screen.getByRole("table", { name: "Bookmarks" });
    expect(expectOnlyOwnFavicons(table)).toEqual([
      "/api/v1/favicons/site1.example.com",
      "/api/v1/favicons/docs.example.org",
      "/api/v1/favicons/xn--bcher-kva.example",
    ]);
  });

  it("shows the monogram of the host until the icon has loaded, and keeps it for the placeholder and for a failed request", async () => {
    use({ listBookmarks: page(bookmarks) });
    await openApp("/bookmarks");
    const first = (await screen.findByRole("link", { name: "Bookmark 1" })).closest("[data-item-id]") as HTMLElement;
    const second = (await screen.findByRole("link", { name: "Bookmark 2" })).closest("[data-item-id]") as HTMLElement;
    const third = (await screen.findByRole("link", { name: "Bookmark 3" })).closest("[data-item-id]") as HTMLElement;
    const frameOf = (card: HTMLElement): HTMLElement => card.querySelector("[data-slot='favicon']") as HTMLElement;

    expect(frameOf(first).textContent).toBe("s");
    expect(frameOf(second).textContent).toBe("d");
    expect(frameOf(third).textContent).toBe("x");

    const stored = pictures(first)[0] as HTMLImageElement;
    Object.defineProperty(stored, "naturalWidth", { configurable: true, value: 64 });
    fireEvent.load(stored);
    const placeholder = pictures(second)[0] as HTMLImageElement;
    Object.defineProperty(placeholder, "naturalWidth", { configurable: true, value: 1 });
    fireEvent.load(placeholder);
    fireEvent.error(pictures(third)[0] as HTMLImageElement);

    await waitFor(() => {
      expect(frameOf(first).getAttribute("data-state")).toBe("loaded");
    });
    expect(frameOf(first).textContent).toBe("");
    expect(pictures(first)).toHaveLength(1);
    expect(frameOf(second).getAttribute("data-state")).toBe("missing");
    expect(frameOf(second).textContent).toBe("d");
    expect(pictures(second)).toHaveLength(0);
    expect(frameOf(third).getAttribute("data-state")).toBe("missing");
    expect(frameOf(third).textContent).toBe("x");
    expect(pictures(third)).toHaveLength(0);
  });
});

describe("the palette", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  async function openPalette(): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      await Promise.resolve();
    });
    return screen.findByRole("dialog", { name: "Command palette" });
  }

  it("draws the recent and pinned bookmarks it lists before anything is typed with the icon of their hosts", async () => {
    use({ listBookmarks: page([bookmark(1, { host: "docs.example.org", pinned: true }), bookmark(2, { host: "mail.example.org" })]) });
    await openApp("/bookmarks");
    const dialog = await openPalette();

    await waitFor(() => {
      expect(pictures(dialog).length).toBeGreaterThan(0);
    });
    const sources = expectOnlyOwnFavicons(dialog);
    expect(new Set(sources)).toEqual(new Set(["/api/v1/favicons/docs.example.org", "/api/v1/favicons/mail.example.org"]));
  });

  it("draws the bookmarks a search finds the same way", async () => {
    use({ listBookmarks: page([]), search: { bookmarks: [found(1), found(2)], folders: [], tags: [] } });
    await openApp("/bookmarks");
    const dialog = await openPalette();

    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "found" } });

    const group = await within(dialog).findByRole("group", { name: "Bookmarks" });
    await waitFor(() => {
      expect(within(group).getAllByRole("option")).toHaveLength(2);
    });
    expect(expectOnlyOwnFavicons(dialog)).toEqual(["/api/v1/favicons/found1.example.org", "/api/v1/favicons/found2.example.org"]);
  });
});

describe("Home", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("draws the quick access tiles and the pinned cards with the icon of their hosts", async () => {
    use({
      getDashboard: {
        counts: { bookmarks: 3, folders: 0, tags: 0, sharedWithYou: null },
        quickAccess: [dashboardBookmark(1, { slug: "one", forwarding: true }), dashboardBookmark(2, { slug: "two", forwarding: true })],
        pinned: [dashboardBookmark(3, { host: "pinned.example.net", url: "https://pinned.example.net/" })],
        topTags: [],
        sharing: null,
        onboarding: { bookmarkAdded: true, slugGiven: true, browserSetupDone: false, folderCreated: true, importDone: false, dismissed: false },
      },
    });
    await openApp("/");
    await screen.findByRole("list", { name: "Most used slugs" });

    expect(expectOnlyOwnFavicons(screen.getByRole("main"))).toEqual([
      "/api/v1/favicons/site1.example.com",
      "/api/v1/favicons/site2.example.com",
      "/api/v1/favicons/pinned.example.net",
    ]);
  });
});
