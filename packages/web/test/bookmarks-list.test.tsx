import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, meOf, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The bookmarks page (doc 03 section 3, doc 02 section 5.7) against the handlers generated from openapi.json, through the
// app's own API client. The failure scenarios are a filter or sort that does not reach the address or the request, a "load
// more" that repeats or skips a page, a count line that claims more or fewer bookmarks than the API reported, a pin that
// is shown only once the server answered or that stays shown after the server refused it, a delete that is sent without
// the confirmation, a failed request shown as an empty list, and a title or address that is rendered as markup or
// followed when it is not a web address.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const LIST = "/api/v1/bookmarks";

function bookmark(n: number, overrides: Partial<Bookmark> = {}): Bookmark {
  const id = `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`;
  return {
    id,
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
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

function page(items: readonly Bookmark[], rest: { nextCursor?: string | null; total?: number | null; totalAtLeast?: 10000 } = {}): unknown {
  return { items, nextCursor: rest.nextCursor ?? null, total: rest.total === undefined ? items.length : rest.total, ...(rest.totalAtLeast === undefined ? {} : { totalAtLeast: rest.totalAtLeast }) };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly ifMatch: string | null;
  readonly keepalive: boolean;
  readonly body: Promise<string>;
}

let calls: Call[] = [];

function use(scenario: Omit<Scenario, "name"> = {}): void {
  server.use(...createHandlers(document_, { scenario: { name: "bookmarks", ...scenario } }));
}

function to(method: string, path: string): Call[] {
  return calls.filter((call) => call.method === method && call.path === path);
}

function lists(): Call[] {
  return to("GET", LIST);
}

async function bodyOf(call: Call | undefined): Promise<unknown> {
  expect(call).toBeDefined();
  return JSON.parse((await call?.body) ?? "null") as unknown;
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    const clone = request.clone();
    calls.push({
      method: request.method,
      path: url.pathname,
      params: url.searchParams,
      ifMatch: request.headers.get("If-Match"),
      keepalive: request.keepalive,
      body: request.method === "GET" || request.method === "DELETE" ? Promise.resolve("") : clone.text(),
    });
  });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
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

/** The card of a bookmark by its title. */
async function card(title: string): Promise<HTMLElement> {
  const link = await screen.findByRole("link", { name: title });
  const item = link.closest("li");
  expect(item).not.toBeNull();
  return item as HTMLElement;
}

async function chooseAction(title: string, action: string): Promise<void> {
  await press(screen.getByRole("button", { name: `Actions for ${title}` }));
  await press(await screen.findByRole("menuitem", { name: action }));
}

async function chooseOption(select: string, option: string): Promise<void> {
  await press(screen.getByRole("combobox", { name: select }));
  await act(async () => {
    const item = await screen.findByRole("option", { name: option });
    // Base UI commits a click only after the press began on the item.
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    await Promise.resolve();
  });
}

function shown(): string {
  return screen.getByText(/^Showing /).textContent;
}

describe("reaching the page", () => {
  it("is the Bookmarks link of the sidebar, and lists the bookmarks under the default sort and size", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1), bookmark(2)]) } });
    await openApp("/");

    await press(await screen.findByRole("link", { name: "Bookmarks" }));

    await screen.findByRole("heading", { level: 1, name: "Bookmarks" });
    expect(window.location.pathname).toBe("/bookmarks");
    expect(screen.getByRole("list", { name: "Bookmarks" }).querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Bookmarks" }).getAttribute("aria-current")).toBe("page");
    expect(lists()).toHaveLength(1);
    expect(lists()[0]?.params.get("sort")).toBe("recent");
    expect(lists()[0]?.params.get("limit")).toBe("24");
    expect(lists()[0]?.params.get("cursor")).toBeNull();
  });
});

describe("a card", () => {
  it("shows the monogram, the title, the host, the missing slug, the pin and the usage as text", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    use({
      fixtures: {
        listBookmarks: page([
          bookmark(1, { title: "<img src=x onerror=alert(1)>", pinned: true, openCount: 142, lastOpenedAt: twoHoursAgo }),
          bookmark(2, { slug: "mail", openCount: 1, lastOpenedAt: twoHoursAgo }),
          bookmark(3),
        ]),
      },
    });
    await openApp("/bookmarks");

    const first = await card("<img src=x onerror=alert(1)>");
    expect(first.querySelector("img")).toBeNull();
    expect(within(first).getByText("site1.example.com").className).toContain("font-mono");
    expect(within(first).getByText("No slug")).toBeDefined();
    expect(within(first).getByRole("img", { name: "Pinned" })).toBeDefined();
    expect(within(first).getByText("142 opens · 2 hr. ago")).toBeDefined();
    expect(first.querySelector("[aria-hidden='true'][translate='no']")?.textContent).toBe("s");
    const second = await card("Bookmark 2");
    expect(within(second).getByText("/go/mail")).toBeDefined();
    expect(within(second).queryByText("No slug")).toBeNull();
    expect(within(second).queryByRole("img", { name: "Pinned" })).toBeNull();
    expect(within(second).getByText("1 open · 2 hr. ago")).toBeDefined();
    const third = await card("Bookmark 3");
    expect(within(third).getByText("Not opened yet")).toBeDefined();
    expect(within(third).getByRole("checkbox", { name: "Select Bookmark 3" })).toBeDefined();
  });

  it("opens the destination in the same tab and counts the open without holding the navigation back", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    const link = await screen.findByRole("link", { name: "Bookmark 1" });
    expect(link.getAttribute("href")).toBe("https://site1.example.com/page");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBeNull();

    let preventedByTheApp: boolean | undefined;
    const stay = (event: MouseEvent): void => {
      preventedByTheApp = event.defaultPrevented;
      // jsdom cannot navigate.
      event.preventDefault();
    };
    document.addEventListener("click", stay);
    await press(link);
    document.removeEventListener("click", stay);

    expect(preventedByTheApp).toBe(false);
    await waitFor(() => {
      expect(to("POST", `${LIST}/${bookmark(1).id}/open`)).toHaveLength(1);
    });
    expect(to("POST", `${LIST}/${bookmark(1).id}/open`)[0]?.keepalive).toBe(true);
  });

  it("counts an open nobody is told about when the count is refused, and still leaves the card as it was", async () => {
    use({ statuses: { openBookmark: 429 }, fixtures: { listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    const link = await screen.findByRole("link", { name: "Bookmark 1" });
    const stay = (event: MouseEvent): void => {
      event.preventDefault();
    };
    document.addEventListener("click", stay);
    await press(link);
    document.removeEventListener("click", stay);

    await waitFor(() => {
      expect(to("POST", `${LIST}/${bookmark(1).id}/open`)).toHaveLength(1);
    });
    // The refusal would be shown within this wait.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.getByRole("link", { name: "Bookmark 1" })).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/could not/)).toBeNull();
  });
});

describe("the address", () => {
  it("is read into the request and the controls", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks?pinned=true&hasSlug=true&forwarding=true&scope=mine&sort=title_asc&size=48");

    await card("Bookmark 1");

    const params = lists()[0]?.params;
    expect(params?.get("pinned")).toBe("true");
    expect(params?.get("hasSlug")).toBe("true");
    expect(params?.get("forwarding")).toBe("true");
    expect(params?.get("scope")).toBe("mine");
    expect(params?.get("sort")).toBe("title_asc");
    expect(params?.get("limit")).toBe("48");
    for (const name of ["Pinned", "Has slug", "Forwarding on"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
    }
    expect(screen.getByRole("radio", { name: "Mine" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Sort by" }).textContent).toContain("Alphabetical A–Z");
    expect(screen.getByRole("combobox", { name: "Bookmarks per load" }).textContent).toContain("48");
  });

  it("drops a value that is none of the allowed ones instead of sending it", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks?sort=bogus&size=7&scope=everyone&pinned=maybe&view=cards");

    await card("Bookmark 1");

    const params = lists()[0]?.params;
    expect(params?.get("sort")).toBe("recent");
    expect(params?.get("limit")).toBe("24");
    expect(params?.get("scope")).toBeNull();
    expect(params?.get("pinned")).toBeNull();
    expect(screen.getByRole("button", { name: "Pinned" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("takes a filter, a sort and a size from the controls, keeps each one linkable and follows back and forward", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await press(screen.getByRole("button", { name: "Pinned" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?pinned=true");
    });
    await waitFor(() => {
      expect(lists().at(-1)?.params.get("pinned")).toBe("true");
    });
    await chooseOption("Sort by", "Most used");
    await waitFor(() => {
      expect(window.location.search).toBe("?pinned=true&sort=most_used");
    });
    await chooseOption("Bookmarks per load", "96");
    await waitFor(() => {
      expect(window.location.search).toBe("?pinned=true&sort=most_used&size=96");
    });
    await waitFor(() => {
      expect(lists().at(-1)?.params.get("limit")).toBe("96");
    });
    expect(lists().at(-1)?.params.get("sort")).toBe("most_used");
    expect(lists().at(-1)?.params.get("pinned")).toBe("true");

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => {
      expect(window.location.search).toBe("?pinned=true&sort=most_used");
    });
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Bookmarks per load" }).textContent).toContain("24");
    });
    expect(screen.getByRole("button", { name: "Pinned" }).getAttribute("aria-pressed")).toBe("true");

    await press(screen.getByRole("button", { name: "Pinned" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?sort=most_used");
    });
    expect(screen.getByRole("button", { name: "Pinned" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the bookmark modal's parameters when a filter changes", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)]), getBookmark: bookmark(1) } });
    await openApp(`/bookmarks?bookmark=${bookmark(1).id}`);
    await screen.findByRole("dialog", { name: "Edit bookmark" });

    await act(async () => {
      // The modal makes the page behind it inert for assistive technology, not for a click.
      fireEvent.click(await screen.findByRole("button", { name: "Pinned", hidden: true }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(window.location.search).toContain("pinned=true");
    });
    expect(window.location.search).toContain(`bookmark=${bookmark(1).id}`);
  });
});

describe("loading more", () => {
  it("asks for the next page with the cursor the last one gave, adds it, and counts what is shown", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1), bookmark(2)], { nextCursor: "cursor-1", total: 3 }) } });
    await openApp("/bookmarks");
    await card("Bookmark 2");
    expect(shown()).toBe("Showing 2 of 3");

    use({ fixtures: { listBookmarks: page([bookmark(3)], { total: 3 }) } });
    await press(screen.getByRole("button", { name: "Load more" }));

    await card("Bookmark 3");
    expect(lists().at(-1)?.params.get("cursor")).toBe("cursor-1");
    expect(lists().at(-1)?.params.get("limit")).toBe("24");
    expect(screen.getAllByRole("link").filter((link) => /^Bookmark \d$/.test(link.textContent))).toHaveLength(3);
    expect(shown()).toBe("Showing 3 of 3");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("says 10,000+ when the API only knows a lower bound, and groups digits by the language", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)], { nextCursor: "c", total: null, totalAtLeast: 10000 }) } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    expect(shown()).toBe("Showing 1 of 10,000+");
  });

  it("shows the exact total with a thousands separator", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)], { nextCursor: "c", total: 1234 }) } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    expect(shown()).toBe("Showing 1 of 1,234");
  });

  it("keeps what is shown and offers a retry when the next page fails", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)], { nextCursor: "c", total: 2 }) } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    use({ statuses: { listBookmarks: 429 } });
    await press(screen.getByRole("button", { name: "Load more" }));

    expect((await screen.findByRole("alert")).textContent).toContain("More bookmarks could not be loaded");
    expect(screen.getByRole("link", { name: "Bookmark 1" })).toBeDefined();
    expect(shown()).toBe("Showing 1 of 2");

    use({ fixtures: { listBookmarks: page([bookmark(2)], { total: 2 }) } });
    await press(within(screen.getByRole("alert")).getByRole("button", { name: "Try again" }));

    await card("Bookmark 2");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(lists().at(-1)?.params.get("cursor")).toBe("c");
  });
});

describe("pinning", () => {
  it("offers Unpin on a pinned bookmark and sends the unpin", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1, { pinned: true })]), updateBookmark: { ...bookmark(1), version: 4 } } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await chooseAction("Bookmark 1", "Unpin");

    await waitFor(() => {
      expect(to("PATCH", `${LIST}/${bookmark(1).id}`)).toHaveLength(1);
    });
    expect(await bodyOf(to("PATCH", `${LIST}/${bookmark(1).id}`)[0])).toEqual({ pinned: false });
  });

  it("puts the unpin back and says the bookmark changed elsewhere when the version is stale", async () => {
    use({ statuses: { updateBookmark: 412 }, fixtures: { listBookmarks: page([bookmark(1, { pinned: true })]) } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await chooseAction("Bookmark 1", "Unpin");

    expect((await screen.findAllByText("This bookmark changed elsewhere. The list is up to date now; try again.")).length).toBeGreaterThan(0);
    expect(within(await card("Bookmark 1")).getByRole("img", { name: "Pinned" })).toBeDefined();
    // The list is read again, so the next try uses the current version.
    await waitFor(() => {
      expect(lists().length).toBeGreaterThan(1);
    });
  });

});

describe("editing and deleting", () => {
  it("opens the bookmark modal on the bookmark from Edit", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)]), getBookmark: bookmark(1) } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await chooseAction("Bookmark 1", "Edit");

    await screen.findByRole("dialog", { name: "Edit bookmark" });
    expect(window.location.search).toBe(`?bookmark=${bookmark(1).id}`);
  });

  it("offers the same actions from the context menu", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    const item = await card("Bookmark 1");

    await act(async () => {
      fireEvent.contextMenu(within(item).getByText("site1.example.com"), { clientX: 4, clientY: 4 });
      await Promise.resolve();
    });

    expect((await screen.findAllByRole("menuitem")).map((entry) => entry.textContent)).toEqual(["Edit", "Pin", "Delete"]);
  });

  it("asks before deleting, deletes nothing on Cancel, and reads the list again after a delete", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1, { slug: "mail" }), bookmark(2)]) } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await chooseAction("Bookmark 1", "Delete");
    const confirm = await screen.findByRole("alertdialog", { name: "Delete this bookmark?" });
    expect(confirm.textContent).toContain("“Bookmark 1” is deleted for good, and its slug stops forwarding immediately.");
    expect(to("DELETE", `${LIST}/${bookmark(1).id}`)).toHaveLength(0);
    await press(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(to("DELETE", `${LIST}/${bookmark(1).id}`)).toHaveLength(0);

    await chooseAction("Bookmark 1", "Delete");
    const reads = lists().length;
    use({ fixtures: { listBookmarks: page([bookmark(2)]) } });
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete bookmark" }));

    await waitFor(() => {
      expect(to("DELETE", `${LIST}/${bookmark(1).id}`)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Bookmark 1" })).toBeNull();
    });
    expect(screen.getByRole("link", { name: "Bookmark 2" })).toBeDefined();
    expect(lists().length).toBeGreaterThan(reads);
    expect(await screen.findByText("Bookmark deleted.")).toBeDefined();
  });

  it("keeps the card and says so in the dialog when the delete fails", async () => {
    use({ statuses: { deleteBookmark: 503 }, fixtures: { listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    await card("Bookmark 1");
    await chooseAction("Bookmark 1", "Delete");

    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete bookmark" }));

    expect((await within(await screen.findByRole("alertdialog")).findByRole("alert")).textContent).toBe("The bookmark could not be deleted right now. Try again in a moment.");
    expect(screen.queryByText("Bookmark deleted.")).toBeNull();
    // The dialog makes the page behind it inert for assistive technology.
    expect(screen.getByRole("link", { name: "Bookmark 1", hidden: true })).toBeDefined();
  });
});

describe("states", () => {
  it("teaches on an empty workspace and opens the new bookmark modal from the button", async () => {
    use({ fixtures: { listBookmarks: page([]) } });
    await openApp("/bookmarks");

    expect(await screen.findByRole("heading", { level: 2, name: "No bookmarks yet" })).toBeDefined();
    expect(screen.getByText(/Give a bookmark a short, private slug/)).toBeDefined();
    expect(screen.queryByText("No bookmarks match these filters")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pinned" })).toBeNull();
    const main = screen.getByRole("main");
    await press(within(main).getByRole("button", { name: "New bookmark" }));

    await screen.findByRole("dialog", { name: "New bookmark" });
    expect(window.location.search).toBe("?new=1");
  });

  it("says no bookmark matches when filters leave nothing, and clears them", async () => {
    use({ fixtures: { listBookmarks: page([]) } });
    await openApp("/bookmarks?pinned=true&sort=oldest&size=48");

    expect(await screen.findByText("No bookmarks match these filters")).toBeDefined();
    expect(screen.queryByText("No bookmarks yet")).toBeNull();
    await press(within(screen.getByRole("main")).getAllByRole("button", { name: "Clear filters" }).at(-1) as HTMLElement);

    await waitFor(() => {
      expect(window.location.search).toBe("?sort=oldest&size=48");
    });
    await waitFor(() => {
      expect(lists().at(-1)?.params.get("pinned")).toBeNull();
    });
    expect(lists().at(-1)?.params.get("sort")).toBe("oldest");
  });

  it("shows an error banner and no list when the first page cannot be read, and reads again on retry", async () => {
    use({ statuses: { listBookmarks: 429 } });
    await openApp("/bookmarks");

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("The bookmarks could not be loaded. Try again in a moment.");
    expect(screen.queryByText("No bookmarks yet")).toBeNull();
    expect(screen.queryByRole("list", { name: "Bookmarks" })).toBeNull();

    use({ fixtures: { listBookmarks: page([bookmark(1)]) } });
    await press(within(banner).getByRole("button", { name: "Try again" }));

    await card("Bookmark 1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not follow an address that is not a web address", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1, { url: "javascript:alert(1)" })]) } });
    await openApp("/bookmarks");

    expect(await screen.findByRole("heading", { name: "Bookmark 1" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Bookmark 1" })).toBeNull();
  });
});

describe("on a phone", () => {
  it("offers the actions in a drawer and pins from it", async () => {
    stubMatchMedia(true);
    use({ fixtures: { listBookmarks: page([bookmark(1)]), updateBookmark: { ...bookmark(1), pinned: true, version: 4 } } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await press(screen.getByRole("button", { name: "Actions for Bookmark 1" }));
    const drawer = await screen.findByRole("dialog", { name: "Actions for Bookmark 1" });
    await press(within(drawer).getByRole("button", { name: "Pin" }));

    await waitFor(() => {
      expect(to("PATCH", `${LIST}/${bookmark(1).id}`)).toHaveLength(1);
    });
  });
});

describe("in German", () => {
  it("shows the page, the count and the usage in the language of the account", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    use({
      fixtures: {
        getMe: meOf({ ...ACCOUNT_BODY, locale: "de" }),
        listBookmarks: page([bookmark(1, { openCount: 142, lastOpenedAt: twoHoursAgo })], { nextCursor: "c", total: 1234 }),
      },
    });
    await openApp("/bookmarks");

    await screen.findByRole("heading", { level: 1, name: "Lesezeichen" });
    const item = await card("Bookmark 1");
    expect(within(item).getByText("Kein Slug")).toBeDefined();
    expect(within(item).getByText(/^142 Aufrufe · vor 2 Std\.$/)).toBeDefined();
    expect(screen.getByText("1 von 1.234 angezeigt")).toBeDefined();
    expect(screen.getByRole("button", { name: "Mehr laden" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Angeheftet" })).toBeDefined();
  });
});

describe("the table view", () => {
  const ME = "/api/v1/me";

  /** The row of a bookmark by its title. */
  async function row(title: string): Promise<HTMLElement> {
    const link = await screen.findByRole("link", { name: title });
    const tr = link.closest("tr");
    expect(tr).not.toBeNull();
    return tr as HTMLElement;
  }

  it("is `/bookmarks?view=table`: a table of the columns with a row per bookmark, loading 48 at a time", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    use({
      fixtures: {
        listBookmarks: page([
          bookmark(1, { title: "<img src=x onerror=alert(1)>", pinned: true, openCount: 1234, lastOpenedAt: twoHoursAgo, slug: "mail" }),
          bookmark(2, { url: "javascript:alert(1)" }),
        ]),
      },
    });
    await openApp("/bookmarks?view=table");

    const table = await screen.findByRole("table", { name: "Bookmarks" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Select",
      "Title",
      "Slug",
      "Host",
      "Folders",
      "Tags",
      "Opens",
      "Last opened",
      "Added",
      "Actions",
    ]);
    expect(lists()[0]?.params.get("limit")).toBe("48");
    const first = await row("<img src=x onerror=alert(1)>");
    expect(first.querySelector("img")).toBeNull();
    const cells = within(first).getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual(["", "s<img src=x onerror=alert(1)>", "/go/mail", "site1.example.com", "", "", "1,234", "2 hr. ago", "Oct 1, 2026", ""]);
    expect(within(first).getByRole("img", { name: "Pinned" })).toBeDefined();
    expect(within(first).getByRole("checkbox", { name: "Select <img src=x onerror=alert(1)>" })).toBeDefined();
    expect(within(first).getByRole("button", { name: "Actions for <img src=x onerror=alert(1)>" })).toBeDefined();
    // An address that is not a web address is shown as text and is not followed.
    expect(screen.queryByRole("link", { name: "Bookmark 2" })).toBeNull();
    expect(within(table).getByText("Bookmark 2")).toBeDefined();
    expect(within(table).getAllByText("Never")).toHaveLength(1);
  });

  it("orders from a sortable header, keeps the loaded filters and the view, and says how the rows are ordered", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks?view=table&pinned=true");
    await row("Bookmark 1");
    const header = (name: string): HTMLElement => screen.getByRole("columnheader", { name });
    expect(header("Added").getAttribute("aria-sort")).toBe("descending");
    expect(header("Title").getAttribute("aria-sort")).toBe("none");
    expect(within(header("Slug")).queryByRole("button")).toBeNull();

    await press(within(header("Title")).getByRole("button"));
    await waitFor(() => {
      expect(window.location.search).toBe("?view=table&pinned=true&sort=title_asc");
    });
    await waitFor(() => {
      expect(lists().at(-1)?.params.get("sort")).toBe("title_asc");
    });
    expect(lists().at(-1)?.params.get("pinned")).toBe("true");
    expect(header("Title").getAttribute("aria-sort")).toBe("ascending");
    expect(header("Added").getAttribute("aria-sort")).toBe("none");

    await press(within(header("Title")).getByRole("button"));
    await waitFor(() => {
      expect(lists().at(-1)?.params.get("sort")).toBe("title_desc");
    });
    expect(header("Title").getAttribute("aria-sort")).toBe("descending");

    for (const [column, sort] of [["Opens", "most_used"], ["Last opened", "recently_opened"], ["Added", "recent"], ["Added", "oldest"]] as const) {
      await press(within(header(column)).getByRole("button"));
      await waitFor(() => {
        expect(lists().at(-1)?.params.get("sort")).toBe(sort);
      });
    }
    expect(header("Added").getAttribute("aria-sort")).toBe("ascending");
    await press(within(header("Added")).getByRole("button"));
    await waitFor(() => {
      expect(window.location.search).toBe("?view=table&pinned=true");
    });
    expect(lists().at(-1)?.params.get("sort")).toBe("recent");
    // The sort control above the list follows the header.
    expect(screen.getByRole("combobox", { name: "Sort by" }).textContent).toContain("Recently added");
  });

  it("applies the account's default view when the address names none, and the address wins over it", async () => {
    use({ fixtures: { getMe: meOf({ ...ACCOUNT_BODY, defaultView: "table" }), listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");

    await screen.findByRole("table", { name: "Bookmarks" });
    expect(screen.getByRole("radio", { name: "Table" }).getAttribute("aria-checked")).toBe("true");
    expect(lists()[0]?.params.get("limit")).toBe("48");
    cleanup();
    calls = [];

    await openApp("/bookmarks?view=grid");

    await screen.findByRole("list", { name: "Bookmarks" });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("radio", { name: "Grid" }).getAttribute("aria-checked")).toBe("true");
    expect(lists()[0]?.params.get("limit")).toBe("24");
    expect(to("PATCH", ME)).toHaveLength(0);
  });

  it("changes the view from the toggle, writes it to the address and saves it as the account's default", async () => {
    use({ fixtures: { listBookmarks: page([bookmark(1)]), updateMe: { ...ACCOUNT_BODY, defaultView: "table" } } });
    await openApp("/bookmarks?pinned=true");
    await card("Bookmark 1");
    expect(screen.getByRole("radio", { name: "Grid" }).getAttribute("aria-checked")).toBe("true");
    expect(to("PATCH", ME)).toHaveLength(0);

    await press(screen.getByRole("radio", { name: "Table" }));

    await screen.findByRole("table", { name: "Bookmarks" });
    expect(window.location.search).toBe("?pinned=true&view=table");
    await waitFor(() => {
      expect(to("PATCH", ME)).toHaveLength(1);
    });
    expect(await bodyOf(to("PATCH", ME)[0])).toEqual({ defaultView: "table" });
    expect(lists().at(-1)?.params.get("pinned")).toBe("true");
    expect(lists().at(-1)?.params.get("limit")).toBe("48");

    await press(screen.getByRole("radio", { name: "Grid" }));
    await screen.findByRole("list", { name: "Bookmarks" });
    await waitFor(() => {
      expect(to("PATCH", ME)).toHaveLength(2);
    });
    expect(await bodyOf(to("PATCH", ME)[1])).toEqual({ defaultView: "grid" });
    expect(window.location.search).toBe("?pinned=true&view=grid");
  });

  it("saves nothing when the chosen view is the account's default already", async () => {
    use({ fixtures: { getMe: meOf({ ...ACCOUNT_BODY, defaultView: "table" }), listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks?view=grid");
    await card("Bookmark 1");

    await press(screen.getByRole("radio", { name: "Table" }));

    await screen.findByRole("table", { name: "Bookmarks" });
    expect(window.location.search).toBe("?view=table");
    // A save would be sent within this wait.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(to("PATCH", ME)).toHaveLength(0);
  });

  it("keeps the chosen view when the default cannot be saved", async () => {
    use({ statuses: { updateMe: 429 }, fixtures: { listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await press(screen.getByRole("radio", { name: "Table" }));

    await waitFor(() => {
      expect(to("PATCH", ME)).toHaveLength(1);
    });
    await screen.findByRole("table", { name: "Bookmarks" });
    expect(window.location.search).toBe("?view=table");
  });

  it("shows each row as a card below md, with the same actions", async () => {
    stubMatchMedia(true);
    use({ fixtures: { listBookmarks: page([bookmark(1, { openCount: 3 })]) } });
    await openApp("/bookmarks?view=table");

    const list = await screen.findByRole("list", { name: "Bookmarks" });
    expect(screen.queryByRole("table")).toBeNull();
    const item = within(list).getAllByRole("listitem")[0] as HTMLElement;
    expect(within(item).getByRole("link", { name: "Bookmark 1" })).toBeDefined();
    expect(within(item).getByRole("checkbox", { name: "Select Bookmark 1" })).toBeDefined();
    expect(within(item).getByText("Opens")).toBeDefined();
    expect(within(item).getByText("site1.example.com")).toBeDefined();
    await press(within(item).getByRole("button", { name: "Actions for Bookmark 1" }));
    expect(await screen.findByRole("dialog", { name: "Actions for Bookmark 1" })).toBeDefined();
  });

  it("states what is wrong and what matches, as the grid does", async () => {
    use({ statuses: { listBookmarks: 429 } });
    await openApp("/bookmarks?view=table");

    await screen.findByText("The bookmarks could not be loaded. Try again in a moment.");
    expect(screen.queryByRole("table")).toBeNull();
    cleanup();

    use({ fixtures: { listBookmarks: page([]) } });
    await openApp("/bookmarks?view=table&pinned=true");

    await screen.findByText("No bookmarks match these filters");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
