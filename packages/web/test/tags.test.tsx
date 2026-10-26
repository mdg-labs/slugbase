import { MergeTagRequestSchema, RenameTagRequestSchema, type ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The tags page (doc 03 section 7, doc 02 section 7.2) through the app's own API client, against a stubbed transport that keeps
// the member's tags and bookmarks the way the API does: tag counts that follow the links of the bookmarks, a name unique without
// regard to case (409), a merge that moves the links of one tag to another without doubling a bookmark that had both, and a
// delete that takes the tag off its bookmarks. The failure scenarios are a list that failed shown as "no tags", a search or
// bar that covers only the first page, a selection that does not reach the address or the request, a rename onto another
// tag's name that overwrites or fails instead of offering the merge, a merge sent without the confirmation or to the wrong tag,
// a merge or delete that leaves the counts, the preview, the selection or the bookmark's tags out of date, a refusal toasted
// as well as shown in place, a preview that failed shown as "no bookmarks", a tag name or bookmark title rendered as markup,
// and a shortcut or link that does not reach the page.

type Tag = ComponentTypes["schemas"]["Tag"];
type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Transport = (request: Request) => Promise<Response>;

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const TAGS = "/api/v1/tags";
const BOOKMARKS = "/api/v1/bookmarks";

interface StoredTag {
  id: string;
  name: string;
}

type StoredBookmark = Omit<Bookmark, "tags"> & { tagIds: string[] };

function tagId(n: number): string {
  return `0192f3a0-eeee-7000-8000-${String(n).padStart(12, "0")}`;
}

/** What the router writes into the address of the bookmark list for a filter by one tag: the list of tags, as JSON. */
function bookmarksTagSearch(id: string): string {
  return `?tag=${encodeURIComponent(JSON.stringify([id]))}`;
}

function bookmarkId(n: number): string {
  return `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`;
}

function storedBookmark(n: number, tagIds: string[], overrides: Partial<StoredBookmark> = {}): StoredBookmark {
  return {
    id: bookmarkId(n),
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
    tagIds,
    version: 1,
    // The higher the number, the newer the bookmark.
    createdAt: `2026-10-01T${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00.000Z`,
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

function storedBookmarkBody(): Bookmark {
  const { tagIds, ...rest } = storedBookmark(1, [tagId(1)]);
  return { ...rest, tags: tagIds.map((id) => ({ id, name: "Reading" })) };
}

interface Spec {
  /** The tags, in the order of their identifiers, each with the number of bookmarks that carry it alone. */
  readonly counts: readonly (readonly [string, number])[];
  /** Further bookmarks, given by the numbers of the tags in `counts` they carry (1 is the first tag). */
  readonly shared?: readonly (readonly number[])[];
}

interface World {
  readonly tags: StoredTag[];
  readonly bookmarks: StoredBookmark[];
}

function worldOf(spec: Spec): World {
  const tags = spec.counts.map(([name], index): StoredTag => ({ id: tagId(index + 1), name }));
  const bookmarks: StoredBookmark[] = [];
  spec.counts.forEach(([, count], index) => {
    for (let at = 0; at < count; at += 1) {
      bookmarks.push(storedBookmark(bookmarks.length + 1, [tagId(index + 1)]));
    }
  });
  for (const numbers of spec.shared ?? []) {
    bookmarks.push(storedBookmark(bookmarks.length + 1, numbers.map(tagId)));
  }
  return { tags, bookmarks };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly body: unknown;
}

interface Answers {
  /** Replaces the answer to a read of the tag list; undefined falls through to the stub's own. */
  readonly list?: (call: Call) => Response | undefined;
  /** Replaces the answer to a read of the bookmarks. */
  readonly bookmarks?: () => Promise<Response> | Response;
  /** Holds the answer to every read of the tag list until it settles. */
  readonly hold?: Promise<void>;
  /** The status the change, merge or deletion is refused with, with the code of its problem. */
  readonly refuse?: { readonly method: "POST" | "PATCH" | "DELETE"; readonly status: number; readonly code: string };
}

interface Server {
  readonly calls: Call[];
  readonly world: World;
  readonly tagLists: () => Call[];
  readonly bookmarkLists: () => Call[];
  readonly to: (method: string) => Call[];
}

function countOf(world: World, id: string): number {
  return world.bookmarks.filter((candidate) => candidate.tagIds.includes(id)).length;
}

function tagBody(world: World, stored: StoredTag): Tag {
  return { id: stored.id, name: stored.name, bookmarkCount: countOf(world, stored.id), createdAt: "2026-10-01T08:00:00.000Z" };
}

function bookmarkBody(world: World, stored: StoredBookmark): Bookmark {
  const { tagIds, ...rest } = stored;
  const tags = tagIds.flatMap((id) => world.tags.filter((candidate) => candidate.id === id)).sort((a, b) => a.name.localeCompare(b.name));
  return { ...rest, tags: tags.map(({ id, name }) => ({ id, name })) };
}

function byName(a: Tag, b: Tag): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/** A signed-in server that holds `spec` as the caller's tags and bookmarks and answers the tag operations as the API does. */
function stubServer(spec: Spec, answers: Answers = {}): Server {
  const world = worldOf(spec);
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) =>
      signedIn(request, async (other) => {
        const url = new URL(other.url);
        const text = other.method === "GET" || other.method === "DELETE" ? "" : await other.clone().text();
        const body: unknown = text === "" ? undefined : JSON.parse(text);
        const call: Call = { method: other.method, path: url.pathname, params: url.searchParams, body };
        if (url.pathname === "/api/v1/folders") {
          return json({ items: [], nextCursor: null, total: 0 });
        }
        const isTags = url.pathname === TAGS || url.pathname.startsWith(`${TAGS}/`);
        if (!isTags && url.pathname !== BOOKMARKS) {
          return problem(404, "not_found", "req-404");
        }
        calls.push(call);
        if (url.pathname === BOOKMARKS && other.method === "GET") {
          if (answers.bookmarks !== undefined) {
            return answers.bookmarks();
          }
          const wanted = url.searchParams.getAll("tag");
          const limit = Number(url.searchParams.get("limit") ?? "48");
          const matching = world.bookmarks
            .filter((candidate) => wanted.every((id) => candidate.tagIds.includes(id)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          return json({ items: matching.slice(0, limit).map((candidate) => bookmarkBody(world, candidate)), nextCursor: null, total: matching.length });
        }
        const refused = answers.refuse;
        if (refused !== undefined && refused.method === other.method && isTags) {
          return problem(refused.status, refused.code, "req-refused");
        }
        if (url.pathname === TAGS && other.method === "GET") {
          await answers.hold;
          const custom = answers.list?.(call);
          if (custom !== undefined) {
            return custom;
          }
          const limit = Number(url.searchParams.get("limit") ?? "50");
          const offset = Number(url.searchParams.get("cursor") ?? "0");
          const all = world.tags.map((stored) => tagBody(world, stored));
          all.sort(url.searchParams.get("sort") === "count" ? (a, b) => b.bookmarkCount - a.bookmarkCount || byName(a, b) : byName);
          const next = offset + limit;
          return json({ items: all.slice(offset, next), nextCursor: next < all.length ? String(next) : null, total: all.length });
        }
        const rest = url.pathname.slice(TAGS.length + 1).split("/");
        const target = world.tags.find((candidate) => candidate.id === rest[0]);
        if (target === undefined) {
          return problem(404, "not_found", "req-404");
        }
        if (other.method === "PATCH") {
          const parsed = RenameTagRequestSchema.safeParse(body);
          if (!parsed.success) {
            return problem(422, "validation_failed", "req-422");
          }
          if (world.tags.some((candidate) => candidate.id !== target.id && candidate.name.toLowerCase() === parsed.data.name.toLowerCase())) {
            return problem(409, "name_taken", "req-409");
          }
          target.name = parsed.data.name;
          return json(tagBody(world, target));
        }
        if (other.method === "DELETE") {
          world.tags.splice(world.tags.indexOf(target), 1);
          for (const stored of world.bookmarks) {
            stored.tagIds = stored.tagIds.filter((id) => id !== target.id);
          }
          return new Response(null, { status: 204 });
        }
        if (other.method === "POST" && rest[1] === "merge") {
          const parsed = MergeTagRequestSchema.safeParse(body);
          if (!parsed.success) {
            return problem(422, "validation_failed", "req-422");
          }
          if (parsed.data.intoTagId === target.id) {
            return problem(422, "validation_failed", "req-422");
          }
          const into = world.tags.find((candidate) => candidate.id === parsed.data.intoTagId);
          if (into === undefined) {
            return problem(404, "not_found", "req-404");
          }
          for (const stored of world.bookmarks) {
            if (stored.tagIds.includes(target.id)) {
              stored.tagIds = [...new Set(stored.tagIds.map((id) => (id === target.id ? into.id : id)))];
            }
          }
          world.tags.splice(world.tags.indexOf(target), 1);
          return json(tagBody(world, into));
        }
        return problem(404, "not_found", "req-404");
      }),
    ),
  );
  return {
    calls,
    world,
    tagLists: () => calls.filter((call) => call.method === "GET" && call.path === TAGS),
    bookmarkLists: () => calls.filter((call) => call.method === "GET" && call.path === BOOKMARKS),
    to: (method) => calls.filter((call) => call.method === method),
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

async function key(init: KeyboardEventInit, target: Element | Window = window): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, init);
    await Promise.resolve();
  });
}

async function typeInto(field: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(field, { target: { value } });
    await Promise.resolve();
  });
}

/** Queries for the text of the page itself, apart from the top bar's breadcrumb and the sidebar. */
const inPage = {
  findByText: async (text: string | RegExp): Promise<HTMLElement> => within(await screen.findByRole("main", { hidden: true })).findByText(text),
  getByText: (text: string | RegExp): HTMLElement => within(screen.getByRole("main", { hidden: true })).getByText(text),
};

function namesShown(): string[] {
  // An open overlay hides the page behind it from assistive technology, which the queries respect unless told otherwise.
  const table = screen.getByRole("table", { name: "Tags", hidden: true });
  return within(table)
    .getAllByRole("row", { hidden: true })
    .slice(1)
    .map((row) => within(row).getAllByRole("cell", { hidden: true })[0]?.textContent ?? "");
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table", { name: "Tags" })).getByRole("link", { name }).closest("tr");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

function previewTitles(): string[] {
  const table = screen.getByRole("table", { name: /^Newest bookmarks tagged / });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.querySelector("span > a, span > span")?.textContent ?? "");
}

async function chooseAction(name: string, action: string): Promise<void> {
  await press(screen.getByRole("button", { name: `Actions for ${name}` }));
  await press(await screen.findByRole("menuitem", { name: action }));
}

async function chooseOption(select: string, option: string): Promise<void> {
  await press(screen.getByRole("combobox", { name: select }));
  await act(async () => {
    const item = await screen.findByRole("option", { name: option });
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    await Promise.resolve();
  });
}

async function openRename(name: string): Promise<HTMLElement> {
  await chooseAction(name, "Rename");
  return screen.findByRole("dialog", { name: "Rename tag" });
}

const SPEC: Spec = { counts: [["Reading", 12], ["Recipes", 4], ["Archive", 1]] };

describe("reaching the page", () => {
  it("is the Tags link of the sidebar, and lists the tags by name with their counts and a bar for each against the largest", async () => {
    const server = stubServer(SPEC);
    await openApp("/");

    await press(await screen.findByRole("link", { name: "Tags" }));

    await screen.findByRole("heading", { level: 1, name: "Tags" });
    expect(window.location.pathname).toBe("/tags");
    expect(screen.getByRole("link", { name: "Tags" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Tags");
    expect(namesShown()).toEqual(["Archive", "Reading", "Recipes"]);
    expect(within(rowOf("Reading")).getByText("12 bookmarks")).toBeDefined();
    expect(within(rowOf("Archive")).getByText("1 bookmark")).toBeDefined();
    // The longest bar is the most used tag; the others are a share of it.
    for (const [name, now] of [["Reading", "12"], ["Recipes", "4"], ["Archive", "1"]] as const) {
      const bar = within(rowOf(name)).getByRole("progressbar", { name });
      expect(bar.getAttribute("aria-valuenow")).toBe(now);
      expect(bar.getAttribute("aria-valuemax")).toBe("12");
    }
    expect(server.tagLists().every((list) => list.params.get("limit") === "100")).toBe(true);
  });

  it("states that tags are private to the member", async () => {
    stubServer(SPEC);
    await openApp("/tags");

    const note = await screen.findByRole("note");

    expect(note.textContent).toContain("Tags are private to you. Other members of the workspace never see them.");
  });

  it("goes there with G then T from another page, and says so in the shortcut sheet", async () => {
    stubServer(SPEC);
    await openApp("/");
    await screen.findByRole("heading", { level: 1 });

    await key({ key: "g" });
    await key({ key: "t" });

    await screen.findByRole("heading", { level: 1, name: "Tags" });
    expect(window.location.pathname).toBe("/tags");

    await key({ key: "?", shiftKey: true });
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).getByText("Go to Tags")).toBeDefined();
  });

  it("is in German with the account's language", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer({ counts: [["Lesen", 9]] });
    await openApp("/tags");

    await screen.findByRole("heading", { level: 1, name: "Tags" });
    expect(await screen.findByText("Tags sind nur für dich sichtbar. Andere Mitglieder des Arbeitsbereichs sehen sie nie.")).toBeDefined();
    expect(inPage.getByText("9 Lesezeichen")).toBeDefined();
    await press(screen.getByRole("button", { name: "Aktionen für Lesen" }));
    await press(await screen.findByRole("menuitem", { name: "Löschen" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain("Der Tag wird von seinen 9 Lesezeichen entfernt.");
  });
});

describe("searching and sorting", () => {
  it("finds tags by part of the name without regard to case, says when none matches and brings the list back from the clear button", async () => {
    stubServer(SPEC);
    await openApp("/tags");
    await inPage.findByText("Reading");
    const search = screen.getByRole("searchbox", { name: "Search tags" });

    await typeInto(search, "REC");

    expect(namesShown()).toEqual(["Recipes"]);
    await typeInto(search, "zzz");
    expect(screen.queryByRole("table", { name: "Tags" })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "No tag matches" })).toBeDefined();
    expect(inPage.getByText("None of your tags contains “zzz”.")).toBeDefined();
    await press(screen.getByRole("button", { name: "Clear search" }));
    expect(namesShown()).toEqual(["Archive", "Reading", "Recipes"]);
  });

  it("searches and draws the bars over every tag, not the first page: a tag on a later page is found", async () => {
    const counts: [string, number][] = Array.from({ length: 130 }, (_, index) => [`Tag ${String(1000 + index)}`, 0]);
    counts.push(["Zebra", 3]);
    const server = stubServer({ counts });
    await openApp("/tags?sort=count");
    await inPage.findByText("Zebra");

    // 131 tags are two pages of at most 100; the page read both.
    expect(server.tagLists().filter((list) => list.params.get("limit") === "100").length).toBeGreaterThanOrEqual(2);
    await typeInto(screen.getByRole("searchbox", { name: "Search tags" }), "zebra");
    expect(namesShown()).toEqual(["Zebra"]);
    expect(within(rowOf("Zebra")).getByRole("progressbar", { name: "Zebra" }).getAttribute("aria-valuemax")).toBe("3");
  });

  it("sorts by name by default and by count from the control, keeps the choice in the address and drops one that is not offered", async () => {
    stubServer(SPEC);
    await openApp("/tags?sort=updated");
    await inPage.findByText("Reading");
    expect(namesShown()).toEqual(["Archive", "Reading", "Recipes"]);
    expect(screen.getByRole("combobox", { name: "Sort by" }).textContent).toContain("Name");

    await chooseOption("Sort by", "Count");

    await waitFor(() => {
      expect(namesShown()).toEqual(["Reading", "Recipes", "Archive"]);
    });
    expect(window.location.search).toBe("?sort=count");
    await chooseOption("Sort by", "Name");
    await waitFor(() => {
      expect(namesShown()).toEqual(["Archive", "Reading", "Recipes"]);
    });
    expect(window.location.search).toBe("");
  });
});

describe("the preview", () => {
  it("selects a tag from its name into the address and shows its newest bookmarks first, five at most, with the way to all of them", async () => {
    const server = stubServer({ counts: [["Reading", 7], ["Recipes", 2]] });
    await openApp("/tags");
    await inPage.findByText("Reading");
    expect(inPage.getByText("Select a tag to see its newest bookmarks.")).toBeDefined();
    expect(server.bookmarkLists()).toHaveLength(0);

    await press(within(screen.getByRole("table", { name: "Tags" })).getByRole("link", { name: "Reading" }));

    await screen.findByRole("heading", { level: 2, name: "Reading" });
    expect(window.location.search).toBe(`?tag=${tagId(1)}`);
    await screen.findByRole("table", { name: "Newest bookmarks tagged Reading" });
    const list = server.bookmarkLists().at(-1);
    expect(list?.params.getAll("tag")).toEqual([tagId(1)]);
    expect(list?.params.get("sort")).toBe("recent");
    expect(list?.params.get("limit")).toBe("5");
    expect(previewTitles()).toEqual(["Bookmark 7", "Bookmark 6", "Bookmark 5", "Bookmark 4", "Bookmark 3"]);
    expect(within(rowOf("Reading")).getByRole("link", { name: "Reading" }).getAttribute("aria-current")).toBe("page");
    expect(within(rowOf("Recipes")).getByRole("link", { name: "Recipes" }).getAttribute("aria-current")).toBeNull();
    const viewAll = within(screen.getByRole("main")).getByRole("link", { name: "View all in Bookmarks" });
    expect(viewAll.getAttribute("href")).toBe(`/bookmarks${bookmarksTagSearch(tagId(1))}`);
  });

  it("opens on the tag of the address, keeps the sort and goes on to the bookmark list with the tag in the filter", async () => {
    stubServer({ counts: [["Reading", 2], ["Recipes", 1]] });
    await openApp(`/tags?tag=${tagId(2)}&sort=count`);

    await screen.findByRole("heading", { level: 2, name: "Recipes" });
    await screen.findByRole("table", { name: "Newest bookmarks tagged Recipes" });
    await press(within(screen.getByRole("table", { name: "Tags" })).getByRole("link", { name: "Reading" }));
    await screen.findByRole("heading", { level: 2, name: "Reading" });
    expect(new URLSearchParams(window.location.search).get("sort")).toBe("count");

    await press(within(screen.getByRole("main")).getByRole("link", { name: "View all in Bookmarks" }));

    await screen.findByRole("heading", { level: 1, name: "Bookmarks" });
    expect(window.location.pathname).toBe("/bookmarks");
    expect(window.location.search).toBe(bookmarksTagSearch(tagId(1)));
  });

  it("opens the same list from the row's own menu", async () => {
    stubServer({ counts: [["Reading", 2]] });
    await openApp("/tags");
    await inPage.findByText("Reading");

    await chooseAction("Reading", "View all in Bookmarks");

    await screen.findByRole("heading", { level: 1, name: "Bookmarks" });
    expect(window.location.search).toBe(bookmarksTagSearch(tagId(1)));
  });

  it("says a tag of the address that the member does not have is not there, and asks for no bookmarks", async () => {
    const server = stubServer({ counts: [["Reading", 2]] });
    await openApp(`/tags?tag=${tagId(9)}`);

    expect(await inPage.findByText("This tag does not exist. It may have been renamed, merged or deleted.")).toBeDefined();
    expect(server.bookmarkLists()).toHaveLength(0);
  });

  it("shows skeleton rows while the bookmarks are read, then says a tag on no bookmark has none", async () => {
    let release: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer(
      { counts: [["Empty", 0]] },
      {
        bookmarks: async () => {
          await open;
          return json({ items: [], nextCursor: null, total: 0 });
        },
      },
    );
    await openApp(`/tags?tag=${tagId(1)}`);

    const wait = await screen.findByRole("status", { name: "Loading the bookmarks" });
    expect(wait.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("No bookmark carries this tag.")).toBeNull();
    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(await screen.findByText("No bookmark carries this tag.")).toBeDefined();
    expect(screen.queryByRole("status", { name: "Loading the bookmarks" })).toBeNull();
  });

  it("shows an error banner, not an empty tag, when the bookmarks cannot be read, and reads again on retry", async () => {
    let healthy = false;
    stubServer({ counts: [["Reading", 1]] }, { bookmarks: () => (healthy ? json({ items: [storedBookmarkBody()], nextCursor: null, total: 1 }) : problem(503, "service_unavailable", "req-503")) });
    await openApp(`/tags?tag=${tagId(1)}`);

    const banner = await screen.findByText("The bookmarks of this tag could not be loaded. Try again in a moment.");
    expect(screen.queryByText("No bookmark carries this tag.")).toBeNull();
    expect(screen.queryByRole("table", { name: /^Newest bookmarks/ })).toBeNull();

    healthy = true;
    await press(within(banner.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Try again" }));

    await screen.findByRole("table", { name: "Newest bookmarks tagged Reading" });
    expect(previewTitles()).toEqual(["Bookmark 1"]);
  });

  it("renders a tag name and a bookmark title as text, and links only an http or https address", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const server = stubServer({ counts: [[hostile, 2]] });
    Object.assign(server.world.bookmarks[1] ?? {}, { title: hostile, url: "javascript:alert(1)", host: "alert(1)" });
    Object.assign(server.world.bookmarks[0] ?? {}, { title: "Safe" });
    await openApp(`/tags?tag=${tagId(1)}`);

    await screen.findByRole("table", { name: `Newest bookmarks tagged ${hostile}` });

    const main = screen.getByRole("main");
    expect(main.querySelector("img")).toBeNull();
    const preview = within(screen.getByRole("table", { name: `Newest bookmarks tagged ${hostile}` }));
    expect(preview.getByRole("link", { name: "Safe" }).getAttribute("href")).toBe("https://site1.example.com/page");
    expect(preview.getByText(hostile).closest("a")).toBeNull();
    expect(main.querySelector("a[href^='javascript:']")).toBeNull();
  });

  it("opens as a side panel over a narrow screen and closes back to the list", async () => {
    stubMatchMedia(true);
    stubServer({ counts: [["Reading", 2]] });
    await openApp(`/tags?tag=${tagId(1)}`);

    const panel = await screen.findByRole("dialog", { name: "Reading" });
    expect(panel.closest("[data-slot=sheet-viewport]")).not.toBeNull();
    await within(panel).findByRole("link", { name: "View all in Bookmarks" });
    expect(within(panel).getByRole("list", { name: "Newest bookmarks tagged Reading" })).toBeDefined();
    // Not drawn a second time beside the list.
    expect(within(screen.getByRole("main", { hidden: true })).queryByRole("heading", { level: 2, name: "Reading", hidden: true })).toBeNull();

    await press(within(panel).getByRole("button", { name: "Close the preview" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Reading" })).toBeNull();
    });
    expect(window.location.search).toBe("");
  });
});

describe("renaming a tag", () => {
  it("opens the form with the name, sends the new name alone and shows the tag under it", async () => {
    const server = stubServer(SPEC);
    await openApp("/tags");
    await inPage.findByText("Recipes");

    const dialog = await openRename("Recipes");
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Recipes");
    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "  Cooking ");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Tag renamed.")).toBeDefined();
    expect(server.to("PATCH")).toHaveLength(1);
    expect(server.to("PATCH")[0]?.path).toBe(`${TAGS}/${tagId(2)}`);
    expect(server.to("PATCH")[0]?.body).toEqual({ name: "Cooking" });
    await waitFor(() => {
      expect(namesShown()).toEqual(["Archive", "Cooking", "Reading"]);
    });
    expect(screen.queryByRole("dialog", { name: "Rename tag" })).toBeNull();
  });

  it("sends nothing for a name that is blank or unchanged", async () => {
    const server = stubServer(SPEC);
    await openApp("/tags");
    await inPage.findByText("Recipes");
    const dialog = await openRename("Recipes");

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "   ");
    await press(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Enter a name for the tag.")).toBeDefined();
    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Recipes");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Rename tag" })).toBeNull();
    });
    expect(server.to("PATCH")).toHaveLength(0);
  });

  it("shows a refused name at the field, keeps the form and raises no toast for it", async () => {
    stubServer(SPEC, { refuse: { method: "PATCH", status: 422, code: "validation_failed" } });
    await openApp("/tags");
    await inPage.findByText("Recipes");
    const dialog = await openRename("Recipes");

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Cooking");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText("Use a name of 1 to 40 characters.")).toBeDefined();
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Cooking");
    expect(screen.queryByText("The change was not saved")).toBeNull();
  });

  it("keeps the form and what was typed, and raises the error toast, for a failure it cannot tell in place", async () => {
    stubServer(SPEC, { refuse: { method: "PATCH", status: 500, code: "internal" } });
    await openApp("/tags");
    await inPage.findByText("Recipes");
    const dialog = await openRename("Recipes");

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Cooking");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Request ID: req-refused/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Tag renamed.")).toBeNull();
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Cooking");
    expect(namesShown()).toEqual(["Archive", "Reading", "Recipes"]);
  });

  it("says in the form that the tag is gone, without a toast, and reads the list again", async () => {
    const server = stubServer(SPEC);
    await openApp("/tags");
    await inPage.findByText("Recipes");
    const dialog = await openRename("Recipes");
    server.world.tags.splice(1, 1);
    const reads = server.tagLists().length;

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Cooking");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("This tag no longer exists.");
    expect(screen.queryByText("The change was not saved")).toBeNull();
    await waitFor(() => {
      expect(server.tagLists().length).toBeGreaterThan(reads);
    });
  });
});

describe("renaming onto another tag's name", () => {
  it("offers to merge instead of failing, sends nothing until it is confirmed, and merges into the tag of that name", async () => {
    const server = stubServer({ counts: [["Reading", 3], ["Books", 2]] });
    await openApp("/tags");
    await inPage.findByText("Books");
    const dialog = await openRename("Books");

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "reading");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    const confirm = await screen.findByRole("alertdialog", { name: "Merge into “Reading”?" });
    expect(confirm.textContent).toContain("The 2 bookmarks tagged “Books” are tagged “Reading” instead, and “Books” is deleted. The bookmarks stay.");
    expect(server.to("POST")).toHaveLength(0);
    expect(screen.queryByText("You already have a tag with this name.")).toBeNull();
    await press(within(confirm).getByRole("button", { name: "Merge tags" }));

    expect(await screen.findByText("Merged into “Reading”.")).toBeDefined();
    expect(server.to("POST")).toHaveLength(1);
    expect(server.to("POST")[0]?.path).toBe(`${TAGS}/${tagId(2)}/merge`);
    expect(server.to("POST")[0]?.body).toEqual({ intoTagId: tagId(1) });
    await waitFor(() => {
      expect(namesShown()).toEqual(["Reading"]);
    });
    expect(within(rowOf("Reading")).getByText("5 bookmarks")).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Rename tag" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("goes back to the form with the typed name when the merge is declined, and merges nothing", async () => {
    const server = stubServer({ counts: [["Reading", 3], ["Books", 2]] });
    await openApp("/tags");
    await inPage.findByText("Books");
    const dialog = await openRename("Books");
    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Reading");
    await press(within(dialog).getByRole("button", { name: "Save" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Merge into “Reading”?" });

    await press(within(confirm).getByRole("button", { name: "Back to rename" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(within(screen.getByRole("dialog", { name: "Rename tag" })).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Reading");
    expect(server.to("POST")).toHaveLength(0);
    expect(server.world.tags.map((stored) => stored.name)).toEqual(["Reading", "Books"]);
  });

  it("refreshes the counts, the previewed tag's bookmarks and their tags, and moves the selection to the tag that remains", async () => {
    // Bookmark 6 carries both tags; it must be counted once. Bookmarks 1 to 3 carry Reading, 4 and 5 carry Books.
    const server = stubServer({ counts: [["Reading", 3], ["Books", 2]], shared: [[1, 2]] });
    await openApp(`/tags?tag=${tagId(2)}`);
    await screen.findByRole("table", { name: "Newest bookmarks tagged Books" });
    expect(previewTitles()).toEqual(["Bookmark 6", "Bookmark 5", "Bookmark 4"]);
    const dialog = await openRename("Books");
    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Reading");
    await press(within(dialog).getByRole("button", { name: "Save" }));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Merge tags" }));

    // The preview now belongs to the tag that remains, and shows what both tags held.
    await screen.findByRole("table", { name: "Newest bookmarks tagged Reading" });
    expect(window.location.search).toBe(`?tag=${tagId(1)}`);
    expect(screen.getByRole("heading", { level: 2, name: "Reading" })).toBeDefined();
    expect(previewTitles()).toEqual(["Bookmark 6", "Bookmark 5", "Bookmark 4", "Bookmark 3", "Bookmark 2"]);
    expect(within(rowOf("Reading")).getByText("6 bookmarks")).toBeDefined();
    expect(server.world.bookmarks.find((stored) => stored.id === bookmarkId(6))?.tagIds).toEqual([tagId(1)]);
    expect(server.bookmarkLists().at(-1)?.params.getAll("tag")).toEqual([tagId(1)]);
  });

  it("refreshes the preview of the tag that receives the merge when another tag was merged into it", async () => {
    const server = stubServer({ counts: [["Reading", 1], ["Books", 1]] });
    await openApp(`/tags?tag=${tagId(1)}`);
    await screen.findByRole("table", { name: "Newest bookmarks tagged Reading" });
    expect(previewTitles()).toEqual(["Bookmark 1"]);
    const reads = server.bookmarkLists().length;
    const dialog = await openRename("Books");
    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Reading");
    await press(within(dialog).getByRole("button", { name: "Save" }));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Merge tags" }));

    await waitFor(() => {
      expect(previewTitles()).toEqual(["Bookmark 2", "Bookmark 1"]);
    });
    expect(server.bookmarkLists().length).toBeGreaterThan(reads);
    expect(window.location.search).toBe(`?tag=${tagId(1)}`);
  });

  it("keeps the confirmation open with the reason when the tag is gone, and raises no toast for it", async () => {
    const server = stubServer({ counts: [["Reading", 3], ["Books", 2]] });
    await openApp("/tags");
    await inPage.findByText("Books");
    const dialog = await openRename("Books");
    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Reading");
    await press(within(dialog).getByRole("button", { name: "Save" }));
    const confirm = await screen.findByRole("alertdialog");
    server.world.tags.splice(0, 1);

    await press(within(confirm).getByRole("button", { name: "Merge tags" }));

    expect((await within(confirm).findByRole("alert")).textContent).toBe("This tag no longer exists.");
    expect(screen.queryByText("The change was not saved")).toBeNull();
    expect(screen.queryByText(/^Merged into/)).toBeNull();
    expect(screen.getByRole("dialog", { name: "Rename tag", hidden: true })).toBeDefined();
  });

  it("raises the error toast and keeps both overlays when the merge fails for a reason it cannot tell in place", async () => {
    const server = stubServer({ counts: [["Reading", 3], ["Books", 2]] }, { refuse: { method: "POST", status: 500, code: "internal" } });
    await openApp("/tags");
    await inPage.findByText("Books");
    const dialog = await openRename("Books");
    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Reading");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Merge tags" }));

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(screen.queryByText(/^Merged into/)).toBeNull();
    expect(server.world.tags).toHaveLength(2);
    expect(namesShown()).toEqual(["Books", "Reading"]);
  });

  it("merges into the tag that holds the name now, not into the one the page's list shows under it", async () => {
    const server = stubServer({ counts: [["Reading", 3], ["Books", 2], ["Comics", 1]] });
    await openApp("/tags");
    await inPage.findByText("Books");
    const dialog = await openRename("Books");
    // On another device Reading became Novels and Comics became Reading; this page still holds the old names.
    const [reading, , comics] = server.world.tags;
    if (reading === undefined || comics === undefined) {
      throw new Error("The stub holds three tags");
    }
    reading.name = "Novels";
    comics.name = "Reading";
    expect(namesShown()).toEqual(["Books", "Comics", "Reading"]);

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Reading");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    const confirm = await screen.findByRole("alertdialog", { name: "Merge into “Reading”?" });
    expect(server.to("POST")).toHaveLength(0);
    await press(within(confirm).getByRole("button", { name: "Merge tags" }));

    await waitFor(() => {
      expect(server.to("POST")).toHaveLength(1);
    });
    expect(server.to("POST")[0]?.path).toBe(`${TAGS}/${tagId(2)}/merge`);
    expect(server.to("POST")[0]?.body).toEqual({ intoTagId: tagId(3) });
    expect(await screen.findByText("Merged into “Reading”.")).toBeDefined();
    expect(server.world.tags.map((stored) => stored.name)).toEqual(["Novels", "Reading"]);
  });

  it("offers to merge into a tag made elsewhere since the list was read", async () => {
    const server = stubServer({ counts: [["Reading", 3], ["Books", 2]] });
    await openApp("/tags");
    await inPage.findByText("Books");
    const dialog = await openRename("Books");
    server.world.tags.push({ id: tagId(7), name: "Comics" });

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "comics");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    const confirm = await screen.findByRole("alertdialog", { name: "Merge into “Comics”?" });
    await press(within(confirm).getByRole("button", { name: "Merge tags" }));
    expect(await screen.findByText("Merged into “Comics”.")).toBeDefined();
    expect(server.to("POST")[0]?.body).toEqual({ intoTagId: tagId(7) });
  });

  it("offers no merge when no other tag holds the name in the fresh list, and keeps the form with what was typed", async () => {
    // The refusal is the API's answer to a name that was taken when the rename arrived.
    const server = stubServer({ counts: [["Reading", 3], ["Books", 2]] }, { refuse: { method: "PATCH", status: 409, code: "name_taken" } });
    await openApp("/tags");
    await inPage.findByText("Books");
    const dialog = await openRename("Books");
    // The tag of that name was deleted elsewhere after the page read it.
    server.world.tags.splice(0, 1);
    const reads = server.tagLists().length;

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Reading");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(server.tagLists().length).toBeGreaterThan(reads);
    });
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(within(dialog).queryByText("You already have a tag with this name.")).toBeNull();
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Reading");
    expect(server.to("POST")).toHaveLength(0);
  });

  it("offers no merge when the fresh read fails, says the name is taken at the field and merges nothing", async () => {
    let failing = false;
    const server = stubServer({ counts: [["Reading", 3], ["Books", 2]] }, {
      list: () => (failing ? problem(500, "internal", "req-500") : undefined),
    });
    await openApp("/tags");
    await inPage.findByText("Books");
    const dialog = await openRename("Books");
    failing = true;

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Reading");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText("You already have a tag with this name.")).toBeDefined();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Reading");
    expect(server.to("POST")).toHaveLength(0);
  });
});

describe("deleting a tag", () => {
  it("asks first, naming how many bookmarks it comes off, and deletes only on confirmation", async () => {
    const server = stubServer(SPEC);
    await openApp("/tags");
    await inPage.findByText("Reading");

    await chooseAction("Reading", "Delete");

    const dialog = await screen.findByRole("alertdialog", { name: "Delete “Reading”?" });
    expect(dialog.textContent).toContain("The tag is taken off its 12 bookmarks. The bookmarks stay; only the tag goes.");
    expect(server.to("DELETE")).toHaveLength(0);
    const reads = server.tagLists().length;
    await press(within(dialog).getByRole("button", { name: "Delete tag" }));

    await waitFor(() => {
      expect(server.to("DELETE")).toHaveLength(1);
    });
    expect(server.to("DELETE")[0]?.path).toBe(`${TAGS}/${tagId(1)}`);
    expect(await screen.findByText("Tag deleted.")).toBeDefined();
    await waitFor(() => {
      expect(namesShown()).toEqual(["Archive", "Recipes"]);
    });
    expect(server.tagLists().length).toBeGreaterThan(reads);
    expect(server.world.bookmarks).toHaveLength(17);
  });

  it("states the singular and the unused tag in their own words", async () => {
    stubServer({ counts: [["One", 1], ["Unused", 0]] });
    await openApp("/tags");
    await inPage.findByText("One");

    await chooseAction("One", "Delete");
    expect((await screen.findByRole("alertdialog")).textContent).toContain("The tag is taken off its 1 bookmark.");
    await press(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    await chooseAction("Unused", "Delete");

    expect((await screen.findByRole("alertdialog")).textContent).toContain("No bookmark carries this tag; only the tag goes.");
  });

  it("deletes nothing when the dialog is cancelled", async () => {
    const server = stubServer(SPEC);
    await openApp("/tags");
    await inPage.findByText("Reading");
    await chooseAction("Reading", "Delete");

    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(server.to("DELETE")).toHaveLength(0);
    expect(namesShown()).toEqual(["Archive", "Reading", "Recipes"]);
  });

  it("clears the selection and its preview when the selected tag goes, and leaves it alone when another does", async () => {
    stubServer(SPEC);
    await openApp(`/tags?tag=${tagId(2)}`);
    await screen.findByRole("table", { name: "Newest bookmarks tagged Recipes" });

    await chooseAction("Archive", "Delete");
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete tag" }));
    await waitFor(() => {
      expect(namesShown()).toEqual(["Reading", "Recipes"]);
    });
    expect(window.location.search).toBe(`?tag=${tagId(2)}`);
    expect(screen.getByRole("heading", { level: 2, name: "Recipes" })).toBeDefined();

    await chooseAction("Recipes", "Delete");
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete tag" }));

    await waitFor(() => {
      expect(namesShown()).toEqual(["Reading"]);
    });
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("table", { name: /^Newest bookmarks/ })).toBeNull();
    expect(inPage.getByText("Select a tag to see its newest bookmarks.")).toBeDefined();
  });

  it("keeps the row and says so in the dialog, with no second toast, when the tag is already gone", async () => {
    stubServer(SPEC, { refuse: { method: "DELETE", status: 404, code: "not_found" } });
    await openApp("/tags");
    await inPage.findByText("Reading");
    await chooseAction("Reading", "Delete");

    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete tag" }));

    expect((await within(await screen.findByRole("alertdialog")).findByRole("alert")).textContent).toBe("This tag no longer exists.");
    expect(screen.queryByText("The change was not saved")).toBeNull();
    expect(screen.queryByText("Tag deleted.")).toBeNull();
  });

  it("keeps the row and raises the error toast when the delete fails for another reason", async () => {
    const server = stubServer(SPEC, { refuse: { method: "DELETE", status: 503, code: "service_unavailable" } });
    await openApp("/tags");
    await inPage.findByText("Reading");
    await chooseAction("Reading", "Delete");

    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete tag" }));

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(server.to("DELETE")).toHaveLength(1);
    expect(screen.queryByText("Tag deleted.")).toBeNull();
    expect(server.world.tags).toHaveLength(3);
    expect(inPage.getByText("Reading")).toBeDefined();
  });
});

describe("states", () => {
  it("shows skeleton rows while the tags are read, not an empty page, and then the tags", async () => {
    let release: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubServer(SPEC, { hold: open });
    await openApp("/tags");

    const wait = await screen.findByRole("status", { name: "Loading the tags" });
    expect(wait.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("No tags yet")).toBeNull();
    expect(screen.queryByRole("table", { name: "Tags" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    await act(async () => {
      release();
      await Promise.resolve();
    });

    await inPage.findByText("Reading");
    expect(screen.queryByRole("status", { name: "Loading the tags" })).toBeNull();
    expect(server.tagLists().length).toBeGreaterThan(0);
  });

  it("teaches on a member with no tags and leads to Bookmarks", async () => {
    stubServer({ counts: [] });
    await openApp("/tags");

    expect(await screen.findByRole("heading", { level: 2, name: "No tags yet" })).toBeDefined();
    expect(screen.getByText(/Add a tag when you save or edit a bookmark/)).toBeDefined();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();

    await press(within(screen.getByRole("main")).getByRole("link", { name: "Go to Bookmarks" }));

    await screen.findByRole("heading", { level: 1, name: "Bookmarks" });
    expect(window.location.pathname).toBe("/bookmarks");
  });

  it("shows an error banner and no list when the tags cannot be read, and reads again on retry", async () => {
    let healthy = false;
    stubServer(SPEC, { list: () => (healthy ? undefined : problem(503, "service_unavailable", "req-503")) });
    await openApp("/tags");

    const banner = await screen.findByText("The tags could not be loaded. Try again in a moment.");
    expect(screen.queryByText("No tags yet")).toBeNull();
    expect(screen.queryByRole("table", { name: "Tags" })).toBeNull();

    healthy = true;
    await press(within(banner.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Try again" }));

    await inPage.findByText("Reading");
    expect(screen.queryByText("The tags could not be loaded. Try again in a moment.")).toBeNull();
  });

  it("shows an error, not a short list, when a later page of the tags cannot be read", async () => {
    const counts: [string, number][] = Array.from({ length: 120 }, (_, index) => [`Tag ${String(1000 + index)}`, 0]);
    stubServer({ counts }, { list: (call) => (call.params.has("cursor") ? problem(503, "service_unavailable", "req-503") : undefined) });
    await openApp("/tags");

    await screen.findByText("The tags could not be loaded. Try again in a moment.");

    expect(screen.queryByRole("table", { name: "Tags" })).toBeNull();
    expect(screen.queryByText("No tags yet")).toBeNull();
  });

  it("renders a tag name as text, never as markup", async () => {
    stubServer({ counts: [["<img src=x onerror=alert(1)>", 1]] });
    await openApp("/tags");

    const cell = await inPage.findByText("<img src=x onerror=alert(1)>");

    expect(cell.querySelector("img")).toBeNull();
    expect(screen.getByRole("main").querySelector("img")).toBeNull();
  });
});
