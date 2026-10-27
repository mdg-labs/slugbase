import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, allowSlowRender, meOf, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// Searching in the command palette (doc 02 section 9.1 and 9.2, doc 03 section 9) against the handlers generated from
// openapi.json. The failure scenarios are a search that fires on every key instead of after the typing pauses, a late answer
// that replaces the results of a newer query, a request that is left running when the query changes, a result that the
// palette narrows a second time by the query, Alt Enter that edits a bookmark of another member, a search that fails and shows
// nothing, a hint to create that carries the wrong field, and a stranger's title, slug or name that is drawn as markup.

type SearchResults = ComponentTypes["schemas"]["SearchResults"];
type SearchBookmark = ComponentTypes["schemas"]["SearchBookmark"];
type Bookmark = ComponentTypes["schemas"]["Bookmark"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const OWNER = ACCOUNT_BODY.id;
const OTHER_OWNER = "0192f3a0-bbbb-7000-8000-0000000000ff";
const SEARCH = "/api/v1/search";

function found(n: number, overrides: Partial<SearchBookmark> = {}): SearchBookmark {
  return {
    id: `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`,
    title: `Bookmark ${String(n)}`,
    url: `https://site${String(n)}.example.com/page`,
    host: `site${String(n)}.example.com`,
    slug: null,
    forwarding: false,
    pinned: false,
    ...overrides,
  };
}

const DOCS = found(1, { title: "Team handbook", slug: "docs", host: "docs.example.org", url: "https://docs.example.org/", forwarding: true });
const BOARD = found(2, { title: "Board", host: "board.example.org", url: "https://board.example.org/" });
const FOLDER = { id: "0192f3a0-dddd-7000-8000-000000000001", name: "Reading", icon: "folder", color: 1 };
const TAG = { id: "0192f3a0-eeee-7000-8000-000000000001", name: "reference" };
const RESULTS: SearchResults = { bookmarks: [DOCS, BOARD], folders: [FOLDER], tags: [TAG] };
const FOLDER_ROW = { ...FOLDER, ownerId: OWNER, bookmarkCount: 2, version: 1, createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" };
const TAG_ROW = { ...TAG, bookmarkCount: 2, createdAt: "2026-10-01T08:00:00.000Z" };
const NONE: SearchResults = { bookmarks: [], folders: [], tags: [] };

function owned(bookmark: SearchBookmark, ownerId: string): Bookmark {
  return { ...bookmark, ownerId, description: null, openCount: 0, lastOpenedAt: null, folders: [], tags: [], version: 1, createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
  readonly signal: AbortSignal;
}

let calls: Call[] = [];

function to(method: string, path: string): Call[] {
  return calls.filter((call) => call.method === method && call.path === path);
}

/** The `q` of every search request, in the order they came. */
function queries(): (string | null)[] {
  return to("GET", SEARCH).map((call) => call.search.get("q"));
}

type Resolver = (request: Request) => Response | Promise<Response>;

const FIXTURES = { getMe: meOf(ACCOUNT_BODY), listBookmarks: { items: [], nextCursor: null, total: 0 } };

let steered: Readonly<Record<string, Resolver>> = {};
let fixtures: Readonly<Record<string, unknown>> = FIXTURES;

/** Handlers for the generated operations, with `resolvers` answering the operations a test steers; each call adds to the ones before it. */
function use(resolvers: Readonly<Record<string, Resolver>> = {}, changed: Readonly<Record<string, unknown>> = {}): void {
  steered = { ...steered, ...resolvers };
  fixtures = { ...fixtures, ...changed };
  server.use(...createResolverHandlers(document_, steered), ...createHandlers(document_, { scenario: { name: "palette-search", fixtures } }));
}

type Answer = (q: string) => Response | Promise<Response>;

function answerSearch(answer: Answer): void {
  use({ search: (request) => answer(new URL(request.url).searchParams.get("q") ?? "") });
}

function results(body: SearchResults): Response {
  return json(body);
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) } });
}

function failure(): Response {
  return json({ type: "https://slugbase.app/problems/internal", title: "internal", status: 503, code: "unavailable", detail: "x", requestId: "r" }, { status: 503, headers: { "Content-Type": "application/problem+json" } });
}

/** The bookmark the edit check reads. */
function answerBookmark(answer: () => Response): void {
  use({ getBookmark: answer });
}

/** A request the test answers when it chooses to. */
function deferred(): { readonly promise: Promise<Response>; readonly resolve: (response: Response) => void } {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname, search: url.searchParams, signal: request.signal });
  });
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
  window.history.replaceState(null, "", "/");
  steered = {};
  fixtures = FIXTURES;
  use({ search: () => results(RESULTS) });
});

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
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

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function openPalette(): Promise<HTMLElement> {
  await key({ key: "k", ctrlKey: true });
  return screen.findByRole("dialog", { name: "Command palette" });
}

function type(dialog: HTMLElement, value: string): void {
  fireEvent.change(within(dialog).getByRole("combobox"), { target: { value } });
}

function status(dialog: HTMLElement): string | null | undefined {
  return dialog.querySelector("[role='status'][aria-live='polite']")?.textContent;
}

function labelsOf(group: HTMLElement): string[] {
  return within(group).getAllByRole("option").map((option) => option.querySelector("span.truncate")?.textContent ?? "");
}

/** The Bookmarks group once the search has answered and listed something in it. */
async function loaded(dialog: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const group = within(dialog).getByRole("group", { name: "Bookmarks" });
    expect(within(group).getAllByRole("option").length).toBeGreaterThan(0);
    return group;
  });
}

async function search(text: string): Promise<HTMLElement> {
  await openApp();
  const dialog = await openPalette();
  type(dialog, text);
  return dialog;
}

describe("searching as the member types", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("searches once, after the typing has been idle for 150 ms, for the whole text", async () => {
    answerSearch(() => results(RESULTS));
    await openApp();
    const dialog = await openPalette();

    type(dialog, "t");
    type(dialog, "te");
    type(dialog, "tea");

    expect(queries()).toEqual([]);
    await loaded(dialog);
    expect(queries()).toEqual(["tea"]);
  });

  it("groups the results as Bookmarks, Folders, Tags and Commands, with the slug chip and host on a bookmark", async () => {
    answerSearch(() => results(RESULTS));
    const dialog = await search("sett");

    const bookmarks = await loaded(dialog);
    expect(labelsOf(bookmarks)).toEqual(["Team handbook", "Board"]);
    const [first, second] = within(bookmarks).getAllByRole("option");
    expect(first?.querySelector("[data-slot='slug-chip']")?.textContent).toBe("/go/docs");
    expect(first?.textContent).toContain("docs.example.org");
    expect(second?.querySelector("[data-slot='slug-chip']")).toBeNull();
    expect(labelsOf(within(dialog).getByRole("group", { name: "Folders" }))).toEqual(["Reading"]);
    expect(labelsOf(within(dialog).getByRole("group", { name: "Tags" }))).toEqual(["reference"]);
    expect(labelsOf(within(dialog).getByRole("group", { name: "Commands" }))).toEqual(["Settings"]);
    expect(within(dialog).queryByRole("group", { name: "Recent" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Navigation" })).toBeNull();
    expect(status(dialog)).toBe("5 results");
  });

  it("lists what the server found even when the title does not contain the query", async () => {
    answerSearch(() => results({ bookmarks: [BOARD], folders: [], tags: [] }));
    const dialog = await search("kanban");

    expect(labelsOf(await loaded(dialog))).toEqual(["Board"]);
    expect(status(dialog)).toBe("1 result");
  });

  it("matches the commands in the browser, by name and keywords, without waiting for the search", async () => {
    const pending = deferred();
    answerSearch(() => pending.promise);
    const dialog = await search("dark");

    expect(labelsOf(await within(dialog).findByRole("group", { name: "Commands" }))).toEqual(["Toggle theme"]);
    pending.resolve(results(NONE));
  });

  it("shows skeleton rows and says it is searching while the request runs", async () => {
    const pending = deferred();
    answerSearch(() => pending.promise);
    const dialog = await search("handbook");

    await waitFor(() => {
      expect(queries()).toEqual(["handbook"]);
    });
    const group = within(dialog).getByRole("group", { name: "Bookmarks" });
    expect(group.querySelectorAll("[data-slot='skeleton']")).toHaveLength(3);
    expect(status(dialog)).toBe("Searching");
    pending.resolve(results(RESULTS));
    expect(labelsOf(await loaded(dialog))[0]).toBe("Team handbook");
    expect(dialog.querySelectorAll("[data-slot='skeleton']")).toHaveLength(0);
  });

  it("cancels the request in flight when the query changes and ignores an answer that arrives out of order", async () => {
    const first = deferred();
    answerSearch((q) => (q === "han" ? first.promise : results({ bookmarks: [BOARD], folders: [], tags: [] })));
    await openApp();
    const dialog = await openPalette();

    type(dialog, "han");
    await waitFor(() => {
      expect(queries()).toEqual(["han"]);
    });
    type(dialog, "hand");
    expect(labelsOf(await loaded(dialog))).toEqual(["Board"]);

    expect(to("GET", SEARCH)[0]?.signal.aborted).toBe(true);
    await act(async () => {
      first.resolve(results({ bookmarks: [DOCS], folders: [], tags: [] }));
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(labelsOf(within(dialog).getByRole("group", { name: "Bookmarks" }))).toEqual(["Board"]);
    expect(within(dialog).queryByRole("option", { name: /Team handbook/ })).toBeNull();
  });

  it("does not ask the server for a query longer than it accepts, and offers to create instead", async () => {
    const address = `https://example.com/${"a".repeat(120)}`;
    const dialog = await search(address);

    expect(await within(dialog).findByRole("option", { name: `Create a bookmark for ${address}` })).toBeTruthy();
    expect(queries()).toEqual([]);
  });
});

describe("choosing a result", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    answerSearch(() => results(RESULTS));
  });

  it("opens the highlighted bookmark with Enter, counting the open", async () => {
    const dialog = await search("handbook");
    await loaded(dialog);
    // jsdom cannot navigate away from the page; the address the palette goes to is what the test reads.
    const assign = vi.fn<(url: string) => void>();
    const real = window.location;
    const { href, origin, pathname, search: query, hash } = real;
    vi.stubGlobal("location", { href, origin, pathname, search: query, hash, assign });

    await key({ key: "Enter" }, within(dialog).getByRole("combobox"));
    vi.stubGlobal("location", real);

    await waitFor(() => {
      expect(to("POST", `/api/v1/bookmarks/${DOCS.id}/open`)).toHaveLength(1);
    });
    expect(assign).toHaveBeenCalledExactlyOnceWith("https://docs.example.org/");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
  });

  it("opens the bookmark in a new tab, without an opener, with Ctrl Enter", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const dialog = await search("handbook");
    await loaded(dialog);

    await key({ key: "Enter", ctrlKey: true }, within(dialog).getByRole("combobox"));

    expect(open).toHaveBeenCalledWith("https://docs.example.org/", "_blank", "noopener,noreferrer");
    await waitFor(() => {
      expect(to("POST", `/api/v1/bookmarks/${DOCS.id}/open`)).toHaveLength(1);
    });
  });

  it("opens a bookmark that is not a web address nowhere", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    answerSearch(() => results({ bookmarks: [found(3, { title: "Script", url: "javascript:alert(1)" })], folders: [], tags: [] }));
    const dialog = await search("script");
    await loaded(dialog);

    await key({ key: "Enter", ctrlKey: true }, within(dialog).getByRole("combobox"));

    expect(open).not.toHaveBeenCalled();
    expect(to("POST", `/api/v1/bookmarks/${found(3).id}/open`)).toHaveLength(0);
  });

  it("edits the highlighted bookmark with Alt Enter when it is the member's own", async () => {
    answerBookmark(() => json(owned(DOCS, OWNER)));
    const dialog = await search("handbook");
    await loaded(dialog);

    await key({ key: "Enter", altKey: true }, within(dialog).getByRole("combobox"));

    await waitFor(() => {
      expect(window.location.search).toContain(`bookmark=${DOCS.id}`);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
  });

  it("does not edit another member's bookmark with Alt Enter", async () => {
    answerBookmark(() => json(owned(DOCS, OTHER_OWNER)));
    const dialog = await search("handbook");
    await loaded(dialog);

    await key({ key: "Enter", altKey: true }, within(dialog).getByRole("combobox"));

    await waitFor(() => {
      expect(to("GET", `/api/v1/bookmarks/${DOCS.id}`)).toHaveLength(1);
    });
    expect(window.location.search).not.toContain("bookmark=");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });

  it("says so when the bookmark to edit cannot be read", async () => {
    answerBookmark(() => failure());
    const dialog = await search("handbook");
    await loaded(dialog);

    await key({ key: "Enter", altKey: true }, within(dialog).getByRole("combobox"));

    expect((await screen.findAllByText("The bookmark could not be opened for editing.")).length).toBeGreaterThan(0);
    expect(to("GET", `/api/v1/bookmarks/${DOCS.id}`)).toHaveLength(1);
    expect(window.location.search).not.toContain("bookmark=");
  });

  it("goes to the bookmarks of a folder", async () => {
    use({}, { listFolders: { items: [FOLDER_ROW], nextCursor: null, total: 1 } });
    const dialog = await search("reading");

    await click(await within(dialog).findByRole("option", { name: /Reading/ }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/bookmarks");
    });
    expect(new URLSearchParams(window.location.search).get("folderId")).toBe(FOLDER.id);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
  });

  it("goes to the bookmarks with a tag", async () => {
    use({}, { listTags: { items: [TAG_ROW], nextCursor: null, total: 1 } });
    const dialog = await search("reference");

    await click(await within(dialog).findByRole("option", { name: /reference/ }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/bookmarks");
    });
    expect(JSON.parse(new URLSearchParams(window.location.search).get("tag") ?? "null")).toEqual([TAG.id]);
  });

  it("runs a command from the results", async () => {
    const dialog = await search("sett");

    await click(await within(dialog).findByRole("option", { name: /Settings/ }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings/account");
    });
  });
});

describe("when nothing matches", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    answerSearch(() => results(NONE));
  });

  it("says no results and offers to create a bookmark for a query that looks like a web address, which opens the modal with the address", async () => {
    const dialog = await search("https://example.com/docs");

    const offer = await within(dialog).findByRole("option", { name: "Create a bookmark for https://example.com/docs" });
    expect(dialog.textContent).toContain("No results");
    expect(status(dialog)).toBe("No results");
    await click(offer);

    const modal = await screen.findByRole("dialog", { name: "New bookmark" });
    expect(within(modal).getByLabelText<HTMLInputElement>("URL").value).toBe("https://example.com/docs");
    expect(within(modal).getByLabelText<HTMLInputElement>("Slug").value).toBe("");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
  });

  it("gives a bare host name the https scheme", async () => {
    const dialog = await search("example.com/docs");

    await click(await within(dialog).findByRole("option", { name: "Create a bookmark for https://example.com/docs" }));

    const modal = await screen.findByRole("dialog", { name: "New bookmark" });
    expect(within(modal).getByLabelText<HTMLInputElement>("URL").value).toBe("https://example.com/docs");
  });

  it("offers to create a bookmark with the query as its slug otherwise", async () => {
    const dialog = await search("Team Wiki");

    await click(await within(dialog).findByRole("option", { name: "Create a bookmark with the slug team-wiki" }));

    const modal = await screen.findByRole("dialog", { name: "New bookmark" });
    expect(within(modal).getByLabelText<HTMLInputElement>("Slug").value).toBe("team-wiki");
    expect(within(modal).getByLabelText<HTMLInputElement>("URL").value).toBe("");
  });

  it("offers a blank bookmark for a query that is neither an address nor a slug", async () => {
    const dialog = await search("what?!");

    await click(await within(dialog).findByRole("option", { name: "Create a bookmark" }));

    const modal = await screen.findByRole("dialog", { name: "New bookmark" });
    expect(within(modal).getByLabelText<HTMLInputElement>("Slug").value).toBe("");
  });

  it("does not offer to create while the search is still running", async () => {
    const pending = deferred();
    answerSearch(() => pending.promise);
    const dialog = await search("whatever");

    await waitFor(() => {
      expect(queries()).toEqual(["whatever"]);
    });

    expect(within(dialog).queryByRole("option", { name: /Create a bookmark/ })).toBeNull();
    expect(dialog.textContent).not.toContain("No results");
    pending.resolve(results(NONE));
  });
});

describe("when the search fails", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows an inline error row beside the matching commands, and searches again when it is chosen", async () => {
    let failing = true;
    answerSearch(() => (failing ? failure() : results(RESULTS)));
    const dialog = await search("sett");

    const row = await within(dialog).findByRole("option", { name: /The search failed\./ });
    expect(within(row).getByText("Try again")).toBeTruthy();
    expect(status(dialog)).toBe("The search failed.");
    expect(labelsOf(within(dialog).getByRole("group", { name: "Commands" }))).toEqual(["Settings"]);
    failing = false;
    await click(row);

    expect(labelsOf(await loaded(dialog))).toEqual(["Team handbook", "Board"]);
    expect(within(dialog).queryByRole("option", { name: /The search failed\./ })).toBeNull();
    expect(queries()).toEqual(["sett", "sett"]);
  });
});

describe("text a stranger wrote", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("draws hostile titles, hosts, slugs and names as text", async () => {
    const markup = "<img src=x onerror=alert(1)>";
    const script = "<script>alert(1)</script>";
    answerSearch(() =>
      results({
        bookmarks: [found(3, { title: markup, slug: script, host: '"><svg onload=alert(1)>' })],
        folders: [{ ...FOLDER, name: script }],
        tags: [{ ...TAG, name: markup }],
      }),
    );
    const dialog = await search("x");

    const bookmarks = await loaded(dialog);
    expect(labelsOf(bookmarks)).toEqual([markup]);
    expect(bookmarks.textContent).toContain(`/go/${script}`);
    expect(labelsOf(within(dialog).getByRole("group", { name: "Folders" }))).toEqual([script]);
    expect(labelsOf(within(dialog).getByRole("group", { name: "Tags" }))).toEqual([markup]);
    expect(dialog.querySelector("img, script, svg[onload]")).toBeNull();
    expect(dialog.querySelector("[onerror], [onload]")).toBeNull();
  });
});

describe("in German", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("names the groups, the wait and the create offer in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    use({ search: () => results(NONE) }, { getMe: meOf({ ...ACCOUNT_BODY, locale: "de" }) });
    await openApp();
    await key({ key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Befehlspalette" });

    type(dialog, "Team Wiki");

    expect(await within(dialog).findByRole("option", { name: "Lesezeichen mit dem Slug team-wiki erstellen" })).toBeTruthy();
    expect(status(dialog)).toBe("Keine Ergebnisse");
  });
});
