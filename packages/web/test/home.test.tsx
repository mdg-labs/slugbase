import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { FixtureDashboardTop } from "./fixture-extension.tsx";
import { allowSlowRender, json, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The Home screen (doc 03 section 2, doc 02 section 9.3) against the handlers generated from openapi.json, through the app's own API
// client. The failure scenarios are a row that shows more than the answer holds or one that is missing, a "Shared with you" tile
// the answer did not offer, a quick access tile or tag link that leads somewhere other than /go/<slug> or the filtered list, a
// pinned link that follows an address that is not http or https, a title or tag name rendered as markup, an empty workspace that
// still shows empty rows, and a failed or pending request shown as an empty screen.

type Dashboard = ComponentTypes["schemas"]["Dashboard"];
type DashboardBookmark = ComponentTypes["schemas"]["DashboardBookmark"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const DASHBOARD = "/api/v1/dashboard";
const TAG_ID = "0192f3a0-eeee-7000-8000-000000000001";

function bookmark(n: number, overrides: Partial<DashboardBookmark> = {}): DashboardBookmark {
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

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    counts: { bookmarks: 1204, folders: 7, tags: 31, sharedWithYou: null },
    quickAccess: [],
    pinned: [],
    topTags: [],
    sharing: null,
    onboarding: { bookmarkAdded: true, slugGiven: true, browserSetupDone: false, folderCreated: true, importDone: false, dismissed: false },
    ...overrides,
  };
}

let reads = 0;

function use(scenario: Omit<Scenario, "name"> = {}): void {
  server.use(...createHandlers(document_, { scenario: { name: "home", ...scenario } }));
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    if (new URL(request.url).pathname === DASHBOARD) {
      reads += 1;
    }
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
  reads = 0;
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openHome(extensions: Parameters<typeof createWebApp>[0]["extensions"] = []): Promise<void> {
  window.history.replaceState(null, "", "/");
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function section(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { level: 2, name });
  const region = heading.closest("section");
  expect(region).not.toBeNull();
  return region as HTMLElement;
}

/** The teaching empty state, which the Getting started checklist beside it shares a New bookmark action with. */
function emptyState(): HTMLElement {
  const empty = screen.getByRole("heading", { level: 2, name: "Save your first bookmark" }).closest("[data-slot='empty']");
  expect(empty).not.toBeNull();
  return empty as HTMLElement;
}

describe("the counts and the search", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the bookmarks, folders and tags as metric tiles in the language's number format, and no Shared with you tile", async () => {
    use({ fixtures: { getDashboard: dashboard() } });
    await openHome();

    const totals = await screen.findByRole("group", { name: "Totals" });
    expect(within(totals).getByText("Bookmarks").nextSibling?.textContent).toBe("1,204");
    expect(within(totals).getByText("Folders").nextSibling?.textContent).toBe("7");
    expect(within(totals).getByText("Tags").nextSibling?.textContent).toBe("31");
    expect(within(totals).queryByText("Shared with you")).toBeNull();
  });

  it("adds the Shared with you tile when the answer carries that count", async () => {
    use({ fixtures: { getDashboard: dashboard({ counts: { bookmarks: 3, folders: 1, tags: 2, sharedWithYou: 5 } }) } });
    await openHome();

    const totals = await screen.findByRole("group", { name: "Totals" });
    expect(within(totals).getByText("Shared with you").nextSibling?.textContent).toBe("5");
  });

  it("opens the command palette from the search field", async () => {
    use({ fixtures: { getDashboard: dashboard() } });
    await openHome();

    await press(await screen.findByRole("button", { name: "Search bookmarks, folders and tags" }));

    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });

  it("renders the dashboard.top slot above the heading and the counts", async () => {
    use({ fixtures: { getDashboard: dashboard() } });
    await openHome([{ id: "notices", slots: { "dashboard.top": FixtureDashboardTop } }]);

    const notice = await screen.findByText("Fixture dashboard notice");
    const heading = screen.getByRole("heading", { level: 1 });
    const totals = await screen.findByRole("group", { name: "Totals" });
    expect(notice.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(totals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("quick access", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows a tile for each slug with the slug in mono, links it to /go/<slug> and names the destination for hover", async () => {
    const quick = Array.from({ length: 8 }, (_, index) => bookmark(index + 1, { slug: `slug${String(index + 1)}`, forwarding: true, openCount: 10 - index }));
    use({ fixtures: { getDashboard: dashboard({ quickAccess: quick }) } });
    await openHome();

    const region = await section("Quick access");
    const list = within(region).getByRole("list", { name: "Most used slugs" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    const link = within(list).getByRole("link", { name: "Bookmark 3" });
    expect(link.getAttribute("href")).toBe("/go/slug3");
    expect(link.getAttribute("title")).toBe("https://site3.example.com/page");
    const chip = within(list).getByText("/go/slug3");
    expect(chip.className).toContain("font-mono");
    expect(link.closest("li")?.querySelector("[translate='no']")?.textContent).toBe("s");
  });

  it("keeps a slug that is not a plain path segment inside the /go/ path", async () => {
    use({ fixtures: { getDashboard: dashboard({ quickAccess: [bookmark(1, { slug: "a/b?c", forwarding: true })] }) } });
    await openHome();

    const region = await section("Quick access");
    expect(within(region).getByRole("link", { name: "Bookmark 1" }).getAttribute("href")).toBe("/go/a%2Fb%3Fc");
  });

  it("says where the slugs will appear when no bookmark has one", async () => {
    use({ fixtures: { getDashboard: dashboard() } });
    await openHome();

    const region = await section("Quick access");
    expect(within(region).getByText("The bookmarks with a slug that you open most appear here.")).toBeTruthy();
    expect(within(region).queryByRole("list")).toBeNull();
  });
});

describe("pinned", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows compact cards that follow the bookmark's address, and View all goes to the pinned list", async () => {
    const pinned = Array.from({ length: 12 }, (_, index) => bookmark(index + 1));
    use({ fixtures: { getDashboard: dashboard({ pinned }) } });
    await openHome();

    const region = await section("Pinned");
    const list = within(region).getByRole("list", { name: "Pinned bookmarks" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(12);
    const link = within(list).getByRole("link", { name: "Bookmark 2" });
    expect(link.getAttribute("href")).toBe("https://site2.example.com/page");
    expect(within(list).getAllByText("site2.example.com")[0]?.className).toContain("font-mono");
    const viewAll = within(region).getByRole("link", { name: "View all →" });
    expect(viewAll.getAttribute("href")).toBe("/bookmarks?pinned=true");

    // The list that the link leads to reads the same parameter, so the filter is the one the Home screen promised.
    use({ fixtures: { getDashboard: dashboard({ pinned }) } });
    await press(viewAll);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/bookmarks");
    });
    expect(window.location.search).toBe("?pinned=true");
  });

  it("counts a click on the card as an open of the bookmark", async () => {
    const opens: string[] = [];
    use({ fixtures: { getDashboard: dashboard({ pinned: [bookmark(4)] }) } });
    server.use(
      ...createResolverHandlers(document_, {
        openBookmark: (request) => {
          opens.push(new URL(request.url).pathname);
          return new Response(null, { status: 204 });
        },
      }),
    );
    await openHome();

    const link = await screen.findByRole("link", { name: "Bookmark 4" });
    link.addEventListener("click", (event) => {
      event.preventDefault();
    });
    await press(link);

    await waitFor(() => {
      expect(opens).toEqual([`/api/v1/bookmarks/${bookmark(4).id}/open`]);
    });
  });

  it("does not follow an address that is not http or https, and draws the title as text", async () => {
    use({
      fixtures: {
        getDashboard: dashboard({ pinned: [bookmark(1, { title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)" }), bookmark(2)] }),
      },
    });
    await openHome();

    const region = await section("Pinned");
    expect(region.querySelector("img:not([src^='/api/v1/favicons/'])")).toBeNull();
    expect(within(region).getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(within(region).queryByRole("link", { name: "<img src=x onerror=alert(1)>" })).toBeNull();
    expect(region.querySelector("a[href^='javascript:']")).toBeNull();
    expect(within(region).getByRole("link", { name: "Bookmark 2" })).toBeTruthy();
  });

  it("says how to pin when nothing is pinned", async () => {
    use({ fixtures: { getDashboard: dashboard() } });
    await openHome();

    const region = await section("Pinned");
    expect(within(region).getByText("Pin a bookmark to keep it here.")).toBeTruthy();
  });
});

describe("most used tags", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows a badge link with the count for each tag, and the link filters the bookmarks by that tag", async () => {
    use({
      fixtures: {
        getDashboard: dashboard({
          topTags: [
            { id: TAG_ID, name: "Reading", bookmarkCount: 1234 },
            { id: "0192f3a0-eeee-7000-8000-000000000002", name: "<b>bold</b>", bookmarkCount: 2 },
          ],
        }),
      },
    });
    await openHome();

    const region = await section("Most used tags");
    expect(region.querySelector("b")).toBeNull();
    expect(within(region).getByText("<b>bold</b>")).toBeTruthy();
    const link = within(region).getByRole("link", { name: "Reading 1,234" });

    await press(link);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/bookmarks");
    });
    expect(JSON.parse(new URLSearchParams(window.location.search).get("tag") ?? "null")).toEqual([TAG_ID]);
  });

  it("says where tags will appear when there are none", async () => {
    use({ fixtures: { getDashboard: dashboard() } });
    await openHome();

    const region = await section("Most used tags");
    expect(within(region).getByText("The tags you put on bookmarks appear here.")).toBeTruthy();
  });
});

describe("a workspace with no bookmarks", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the teaching empty state in place of the three rows, keeping the counts and the search", async () => {
    use({ fixtures: { getDashboard: dashboard({ counts: { bookmarks: 0, folders: 0, tags: 0, sharedWithYou: null } }) } });
    await openHome();

    expect(await screen.findByRole("heading", { level: 2, name: "Save your first bookmark" })).toBeTruthy();
    expect(screen.getByText("Give a bookmark a short, private slug and open it from anywhere through /go/.")).toBeTruthy();
    expect(within(emptyState()).getByRole("button", { name: "New bookmark" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up your browser" }).getAttribute("href")).toBe("/forwarding");
    expect(screen.queryByRole("heading", { level: 2, name: "Quick access" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Pinned" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Most used tags" })).toBeNull();
    expect(screen.getByRole("group", { name: "Totals" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search bookmarks, folders and tags" })).toBeTruthy();
  });

  it("opens the bookmark modal from New bookmark", async () => {
    use({ fixtures: { getDashboard: dashboard({ counts: { bookmarks: 0, folders: 0, tags: 0, sharedWithYou: null } }) } });
    await openHome();

    await screen.findByRole("heading", { level: 2, name: "Save your first bookmark" });
    await press(within(emptyState()).getByRole("button", { name: "New bookmark" }));

    await waitFor(() => {
      expect(window.location.search).toBe("?new=1");
    });
  });
});

describe("the states of the screen", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows skeleton tiles with the heading and search while the answer is pending, then the rows", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    use({ fixtures: { getDashboard: dashboard() } });
    server.use(
      ...createResolverHandlers(document_, {
        getDashboard: async () => {
          await held;
          return json(dashboard());
        },
      }),
    );
    await openHome();

    const status = await screen.findByRole("status", { name: "Loading your home screen" });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Totals" })).toBeNull();

    release();

    expect(await screen.findByRole("group", { name: "Totals" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading your home screen" })).toBeNull();
  });

  it("shows an error banner with a retry instead of an empty screen, and the rows once the retry works", async () => {
    use({ statuses: { getDashboard: 503 } });
    await openHome();

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("The home screen could not be loaded")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Save your first bookmark" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Totals" })).toBeNull();
    const before = reads;

    use({ fixtures: { getDashboard: dashboard() } });
    await press(within(banner).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("group", { name: "Totals" })).toBeTruthy();
    expect(reads).toBeGreaterThan(before);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the rows it has and says they may be out of date when a refresh fails", async () => {
    use({ fixtures: { getDashboard: dashboard({ pinned: [bookmark(1)] }) } });
    await openHome();
    await screen.findByRole("link", { name: "Bookmark 1" });

    use({ statuses: { getDashboard: 503 } });
    // Leaving and coming back to Home reads the dashboard again, which the failing answer refuses.
    await press(screen.getByRole("link", { name: "Bookmarks" }));
    await screen.findByRole("heading", { level: 1, name: "Bookmarks" });
    await press(screen.getByRole("link", { name: "Home" }));

    await waitFor(() => {
      expect(screen.getByText("The home screen could not be refreshed, so it may be out of date.")).toBeTruthy();
    });
    expect(screen.getByRole("link", { name: "Bookmark 1" })).toBeTruthy();
  });
});
