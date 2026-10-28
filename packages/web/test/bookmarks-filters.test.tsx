import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The folder section of the sidebar and the folder and tag filters of the bookmark list (doc 03 navigation structure and
// section 3.1) against the handlers generated from openapi.json, through the app's own API client. The failure scenarios
// are a filter that does not reach the address or the request (or an address that does not reach the controls), a
// folder or tag list that failed read as "no folders" or "no tags", a folder of the address that the member does not have
// and that keeps narrowing the list, a "select all matching" that reaches bookmarks the filters hide (or is withheld under a folder or tag filter), and a folder or
// tag name rendered as markup.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Folder = ComponentTypes["schemas"]["Folder"];
type Tag = ComponentTypes["schemas"]["Tag"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const LIST = "/api/v1/bookmarks";
const WORK = "0192f3a0-dddd-7000-8000-000000000001";
const READING = "0192f3a0-dddd-7000-8000-000000000002";
const GONE = "0192f3a0-dddd-7000-8000-000000000099";
const MADE = "0192f3a0-dddd-7000-8000-000000000003";
const TAG_GO = "0192f3a0-eeee-7000-8000-000000000001";
const TAG_RUST = "0192f3a0-eeee-7000-8000-000000000002";
const TAG_ZIG = "0192f3a0-eeee-7000-8000-000000000003";

function folder(id: string, name: string, overrides: Partial<Folder> = {}): Folder {
  return { id, ownerId: OWNER, name, icon: "folder", color: 1, bookmarkCount: 0, version: 1, createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z", ...overrides };
}

function tag(id: string, name: string): Tag {
  return { id, name, bookmarkCount: 0, createdAt: "2026-10-01T08:00:00.000Z" };
}

const FOLDERS = [folder(WORK, "Work", { color: 2 }), folder(READING, "Reading", { color: 5, icon: "book-open" })];
const TAGS = [tag(TAG_GO, "go"), tag(TAG_RUST, "rust"), tag(TAG_ZIG, "zig")];

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
    lastOpenedAt: null,
    folders: [],
    tags: [],
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

function bookmarks(items: readonly Bookmark[], total = items.length): unknown {
  return { items, nextCursor: null, total };
}

function listOf(items: readonly unknown[]): unknown {
  return { items, nextCursor: null, total: items.length };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
}

let calls: Call[] = [];

interface World {
  readonly bookmarks?: unknown;
  readonly folders?: readonly Folder[];
  /** Replaces the folder list's whole answer. */
  readonly foldersBody?: unknown;
  readonly tags?: readonly Tag[];
  /** The identifiers the select-all answers. */
  readonly ids?: readonly string[];
  readonly statuses?: Scenario["statuses"];
}

/** The API as `world` says: the member's bookmarks, folders and tags, and the operations that answer with a problem. */
function serve(world: World = {}): void {
  server.use(
    ...createHandlers(document_, {
      scenario: {
        name: "filters",
        ...(world.statuses === undefined ? {} : { statuses: world.statuses }),
        fixtures: {
          listBookmarks: world.bookmarks ?? bookmarks([bookmark(1)]),
          listFolders: world.foldersBody ?? listOf(world.folders ?? FOLDERS),
          listTags: listOf(world.tags ?? TAGS),
          listBookmarkIds: { ids: world.ids ?? [], truncated: false },
        },
      },
    }),
  );
}

function lists(): Call[] {
  return calls.filter((call) => call.method === "GET" && call.path === LIST);
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
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

async function card(title: string): Promise<HTMLElement> {
  const link = await screen.findByRole("link", { name: title });
  const item = link.closest("[data-item-id]");
  expect(item).not.toBeNull();
  return item as HTMLElement;
}

/** Opens the list of a combobox field the way a press on its input does. */
async function openField(name: string): Promise<HTMLElement> {
  const input = await screen.findByRole("combobox", { name });
  await act(async () => {
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
  return input;
}

async function closeList(input: HTMLElement, field: string): Promise<void> {
  // Choosing in the single folder field closes its list by itself, and Escape in a shut one clears the text.
  if (field !== "Folder") {
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });
  }
  await waitFor(() => {
    expect(document.querySelector("[data-slot='picker-popup'], [data-slot='multi-pick-popup']")).toBeNull();
  });
}

async function choose(field: string, option: string): Promise<void> {
  const input = await openField(field);
  // The page behind a list is hidden from assistive technology until the list has gone.
  const item = await screen.findByRole("option", { name: option, hidden: true });
  await act(async () => {
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    await Promise.resolve();
  });
  await closeList(input, field);
}

function sidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Main navigation" });
}

function chipsOf(field: string): string[] {
  const group = screen.getByRole("combobox", { name: field }).closest("[data-slot='multi-pick-chips']");
  return [...(group?.querySelectorAll("[data-slot='multi-pick-chip']") ?? [])].map((chip) => chip.textContent);
}

describe("the Folders section of the sidebar", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("lists each folder with its colour dot as a link to the folder filter, and the filter names the folder in the breadcrumb", async () => {
    serve({ bookmarks: bookmarks([bookmark(1)]) });
    await openApp("/");

    const work = await within(sidebar()).findByRole("link", { name: "Work" });
    expect(work.getAttribute("href")).toBe(`/bookmarks?folderId=${WORK}`);
    expect(work.querySelector("[aria-hidden='true']")?.className).toContain("bg-folder-2");
    expect(within(sidebar()).getByRole("link", { name: "Reading" }).querySelector("[aria-hidden='true']")?.className).toContain("bg-folder-5");

    await press(work);

    await card("Bookmark 1");
    expect(window.location.pathname).toBe("/bookmarks");
    expect(window.location.search).toBe(`?folderId=${WORK}`);
    expect(lists().at(-1)?.params.get("folderId")).toBe(WORK);
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Bookmarks" }).getAttribute("href")).toBe("/bookmarks");
    expect(within(breadcrumb).getByText("Work").getAttribute("aria-current")).toBe("page");
    expect(within(sidebar()).getByRole("link", { name: "Work" }).getAttribute("aria-current")).toBe("page");
    // The router marks a link to the page current whatever its search; the sidebar highlights the folder alone.
    expect(within(sidebar()).getByRole("link", { name: "Bookmarks" }).getAttribute("data-active")).toBe("false");
    expect(within(sidebar()).getByRole("link", { name: "Work" }).getAttribute("data-active")).toBe("true");
  });

  it("says the folders could not be loaded, and reads them again, instead of saying there are none", async () => {
    serve({ statuses: { listFolders: 429 } });
    await openApp("/");

    await within(sidebar()).findByText("The folder list could not be loaded.");
    expect(within(sidebar()).queryByText("You have no folders yet")).toBeNull();

    serve();
    await press(within(sidebar()).getByRole("button", { name: "Reload folders" }));

    await within(sidebar()).findByRole("link", { name: "Work" });
    expect(within(sidebar()).queryByText("The folder list could not be loaded.")).toBeNull();
  });

  it("treats an answer that is no folder list as a list that failed, and keeps the page", async () => {
    serve({ foldersBody: { apiVersion: "v1" } });
    await openApp("/");

    await within(sidebar()).findByText("The folder list could not be loaded.");
    expect(screen.getByRole("main")).toBeDefined();
  });

  it("says there are no folders when the list is read and empty", async () => {
    serve({ folders: [] });
    await openApp("/");

    await within(sidebar()).findByText("You have no folders yet");
  });

  it("renders a folder name as text, never as markup", async () => {
    serve({ folders: [folder(WORK, "<img src=x onerror=alert(1)>")] });
    await openApp("/");

    const link = await within(sidebar()).findByRole("link", { name: "<img src=x onerror=alert(1)>" });
    expect(link.querySelector("img")).toBeNull();
  });
});

describe("the folder filter", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("takes a folder from the control into the address and the request, shows it as a chip, and takes it off again", async () => {
    serve();
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await choose("Folder", "Reading");

    await waitFor(() => {
      expect(window.location.search).toBe(`?folderId=${READING}`);
    });
    await waitFor(() => {
      expect(lists().at(-1)?.params.get("folderId")).toBe(READING);
    });
    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Folder" }).value).toBe("Reading");
    expect(screen.getByText("Folder: Reading")).toBeDefined();

    await press(screen.getByRole("button", { name: "Remove filter: Folder: Reading" }));

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    await waitFor(() => {
      expect(lists().at(-1)?.params.get("folderId")).toBeNull();
    });
    expect(screen.queryByText("Folder: Reading")).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Folder" }).value).toBe("");
  });

  it("reads the folder out of the address into the request, the control and the chip", async () => {
    serve();
    await openApp(`/bookmarks?folderId=${WORK}`);

    await card("Bookmark 1");

    expect(lists()[0]?.params.get("folderId") ?? lists().at(-1)?.params.get("folderId")).toBe(WORK);
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Folder" }).value).toBe("Work");
    });
    expect(screen.getByText("Folder: Work")).toBeDefined();
  });

  it("drops an address that is no identifier instead of sending it", async () => {
    serve();
    await openApp("/bookmarks?folderId=not-an-id&tag=nope");

    await card("Bookmark 1");

    for (const list of lists()) {
      expect(list.params.get("folderId")).toBeNull();
      expect(list.params.get("tag")).toBeNull();
    }
  });

  it("tells a folder the member does not have, takes it off the address and does not narrow the list by it", async () => {
    serve({ bookmarks: bookmarks([bookmark(1)]) });
    await openApp(`/bookmarks?folderId=${GONE}&pinned=true`);

    expect((await screen.findByText("That folder no longer exists")).closest("[role='status']")).not.toBeNull();
    await waitFor(() => {
      expect(window.location.search).toBe("?pinned=true");
    });
    await card("Bookmark 1");
    await waitFor(() => {
      expect(lists().at(-1)?.params.get("folderId")).toBeNull();
    });
    expect(lists().at(-1)?.params.get("pinned")).toBe("true");
    expect(screen.queryByText(/^Folder: /)).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Folder" }).value).toBe("");

    await press(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText("That folder no longer exists")).toBeNull();
  });

  it("keeps a folder made since the folder list was read, by reading the list again before calling it gone", async () => {
    serve();
    await openApp("/bookmarks");
    await card("Bookmark 1");

    serve({ folders: [...FOLDERS, folder(MADE, "Made")] });
    await act(async () => {
      window.history.pushState(null, "", `/bookmarks?folderId=${MADE}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Folder: Made")).toBeDefined();
    expect(screen.queryByText("That folder no longer exists")).toBeNull();
    expect(window.location.search).toBe(`?folderId=${MADE}`);
    await waitFor(() => {
      expect(lists().at(-1)?.params.get("folderId")).toBe(MADE);
    });
  });

  it("takes the stale folder off with a replacing navigation, so back does not return to it", async () => {
    serve();
    window.history.replaceState(null, "", "/bookmarks");
    window.history.pushState(null, "", `/bookmarks?folderId=${GONE}`);
    const length = window.history.length;
    await openApp(`/bookmarks?folderId=${GONE}`);

    await screen.findByText("That folder no longer exists");
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(window.history.length).toBe(length);
  });

  it("does not call a folder stale while the folder list could not be read, and keeps its chip so it can be taken off", async () => {
    serve({ statuses: { listFolders: 429 } });
    await openApp(`/bookmarks?folderId=${GONE}`);

    await card("Bookmark 1");
    await screen.findByText("The folders could not be loaded.");
    expect(screen.queryByText("That folder no longer exists")).toBeNull();
    expect(window.location.search).toBe(`?folderId=${GONE}`);
    expect(lists().at(-1)?.params.get("folderId")).toBe(GONE);

    await press(screen.getByRole("button", { name: "Remove filter: Folder" }));

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });

  it("says the list is empty for a member with no folders, and that it could not be read for one whose list failed", async () => {
    serve({ folders: [] });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await openField("Folder");

    expect(await screen.findByText("You have no folders yet", { selector: "[data-slot='picker-popup'] *" })).toBeDefined();
  });

  it("offers the retry of a folder list that failed, in the list and under the field, and never reads it as empty", async () => {
    serve({ statuses: { listFolders: 429 } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await openField("Folder");

    const popup = document.querySelector("[data-slot='picker-popup']");
    expect(popup?.querySelector("[data-slot='picker-unavailable']")?.textContent).toBe("The folders could not be loaded.");
    expect(popup?.textContent).not.toContain("You have no folders yet");
    expect(screen.getAllByRole("button", { name: "Try again", hidden: true }).length).toBeGreaterThan(0);
  });
});

describe("the tag filter", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("takes the tags from the control into the address and the request, one parameter each, and takes them off again", async () => {
    serve();
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await choose("Tags", "go");
    await choose("Tags", "rust");

    await waitFor(() => {
      expect(lists().at(-1)?.params.getAll("tag")).toEqual([TAG_GO, TAG_RUST]);
    });
    expect(new URLSearchParams(window.location.search).has("tag")).toBe(true);
    expect(chipsOf("Tags")).toEqual(["go", "rust"]);

    await press(screen.getByRole("button", { name: "Remove tag go" }));

    await waitFor(() => {
      expect(lists().at(-1)?.params.getAll("tag")).toEqual([TAG_RUST]);
    });
    expect(chipsOf("Tags")).toEqual(["rust"]);

    await press(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    await waitFor(() => {
      expect(lists().at(-1)?.params.getAll("tag")).toEqual([]);
    });
    expect(chipsOf("Tags")).toEqual([]);
  });

  it("reads one tag and a list of tags out of the address into the request and the chips", async () => {
    serve();
    await openApp(`/bookmarks?tag=${TAG_GO}&tag=${TAG_ZIG}`);

    await card("Bookmark 1");

    await waitFor(() => {
      expect(chipsOf("Tags")).toEqual(["go", "zig"]);
    });
    expect(lists().at(-1)?.params.getAll("tag")).toEqual([TAG_GO, TAG_ZIG]);
  });

  it("keeps the chip of a tag the member does not have, so it can be taken off", async () => {
    const stray = "0192f3a0-eeee-7000-8000-000000000099";
    serve();
    await openApp(`/bookmarks?tag=${stray}`);

    await card("Bookmark 1");

    await waitFor(() => {
      expect(chipsOf("Tags")).toEqual(["Unknown tag"]);
    });
    await press(screen.getByRole("button", { name: "Remove tag Unknown tag" }));

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });

  it("says the tags could not be loaded, and not that there are none", async () => {
    serve({ statuses: { listTags: 429 } });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await openField("Tags");

    const popup = document.querySelector("[data-slot='multi-pick-popup']");
    expect(popup?.querySelector("[data-slot='multi-pick-unavailable']")?.textContent).toBe("The tags could not be loaded.");
    expect(popup?.textContent).not.toContain("You have no tags yet");
  });

  it("says the member has no tags when the list is read and empty", async () => {
    serve({ tags: [] });
    await openApp("/bookmarks");
    await card("Bookmark 1");

    await openField("Tags");

    expect(await screen.findByText("You have no tags yet", { selector: "[data-slot='multi-pick-popup'] *" })).toBeDefined();
  });
});

describe("the active filters", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows each filter that narrows the list as a chip that takes it off, and Clear filters takes them all", async () => {
    serve();
    await openApp(`/bookmarks?folderId=${WORK}&tag=${TAG_GO}&pinned=true&scope=mine&sort=oldest`);
    await card("Bookmark 1");

    const chips = within(await screen.findByRole("list", { name: "Active filters" }));
    await waitFor(() => {
      expect(chips.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Folder: Work", "Pinned", "Mine"]);
    });

    await press(chips.getByRole("button", { name: "Remove filter: Pinned" }));
    await waitFor(() => {
      expect(window.location.search).not.toContain("pinned");
    });
    expect(window.location.search).toContain("scope=mine");

    await press(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?sort=oldest");
    });
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
  });

  it("offers to select every matching bookmark under a folder filter, asks for the folder's identifiers and selects exactly those", async () => {
    const inFolder = [bookmark(1), bookmark(2), bookmark(3)];
    serve({ bookmarks: bookmarks([bookmark(1)], 3), ids: inFolder.map((item) => item.id) });
    await openApp("/bookmarks");
    await press(within(await card("Bookmark 1")).getByRole("checkbox", { name: "Select Bookmark 1" }));
    expect(await screen.findByRole("button", { name: "Select all 3 matching" })).toBeDefined();

    await press(screen.getByRole("button", { name: "Clear selection" }));
    await press(screen.getByRole("link", { name: "Work" }));
    await press(within(await card("Bookmark 1")).getByRole("checkbox", { name: "Select Bookmark 1" }));
    await press(await screen.findByRole("button", { name: "Select all 3 matching" }));

    expect(await screen.findByText("3 selected")).toBeDefined();
    const asked = calls.filter((call) => call.method === "GET" && call.path === `${LIST}/ids`);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.params.get("folderId")).toBe(WORK);
    expect(asked[0]?.params.getAll("tag")).toEqual([]);
  });

  it("offers it under a tag filter as well and names every tag of the filter in the request", async () => {
    serve({ bookmarks: bookmarks([bookmark(1)], 2), ids: [bookmark(1).id, bookmark(2).id] });
    await openApp(`/bookmarks?tag=${TAG_GO}&tag=${TAG_RUST}`);
    await press(within(await card("Bookmark 1")).getByRole("checkbox", { name: "Select Bookmark 1" }));

    await press(await screen.findByRole("button", { name: "Select all 2 matching" }));

    expect(await screen.findByText("2 selected")).toBeDefined();
    const asked = calls.filter((call) => call.method === "GET" && call.path === `${LIST}/ids`);
    expect(asked[0]?.params.getAll("tag").toSorted()).toEqual([TAG_GO, TAG_RUST].toSorted());
    expect(asked[0]?.params.get("folderId")).toBeNull();
  });
});

describe("the folders and tags of a bookmark", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  const filed = bookmark(1, {
    folders: [
      { id: WORK, name: "Work", icon: "folder", color: 2 },
      { id: READING, name: "Reading", icon: "book-open", color: 5 },
    ],
    tags: [
      { id: TAG_GO, name: "go" },
      { id: TAG_RUST, name: "rust" },
      { id: TAG_ZIG, name: "zig" },
      { id: "0192f3a0-eeee-7000-8000-000000000004", name: "<img src=x onerror=alert(1)>" },
    ],
  });

  it("shows a dot for each folder and the first three tags with a count of the rest on a card", async () => {
    serve({ bookmarks: bookmarks([filed, bookmark(2)]) });
    await openApp("/bookmarks");

    const first = await card("Bookmark 1");

    const dots = within(first).getAllByRole("img", { name: /^(Work|Reading)$/ });
    expect(dots.map((dot) => dot.getAttribute("aria-label"))).toEqual(["Work", "Reading"]);
    expect(dots.map((dot) => dot.className)).toEqual([expect.stringContaining("bg-folder-2"), expect.stringContaining("bg-folder-5")]);
    expect(within(first).getByText("go")).toBeDefined();
    expect(within(first).getByText("rust")).toBeDefined();
    expect(within(first).getByText("zig")).toBeDefined();
    expect(within(first).queryByText("<img src=x onerror=alert(1)>")).toBeNull();
    expect(within(first).getByRole("img", { name: "1 more tag" }).textContent).toBe("+1");
    expect(first.querySelector("img:not([src^='/api/v1/favicons/'])")).toBeNull();
    const second = await card("Bookmark 2");
    expect(within(second).queryByRole("img", { name: /^(Work|Reading)$/ })).toBeNull();
  });

  it("shows them in the folders and tags columns of the table", async () => {
    serve({ bookmarks: bookmarks([filed]) });
    await openApp("/bookmarks?view=table");

    const row = (await screen.findByRole("link", { name: "Bookmark 1" })).closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getAllByRole("img", { name: /^(Work|Reading)$/ })).toHaveLength(2);
    expect(["go", "rust", "zig"].map((name) => cells.getByText(name).textContent)).toEqual(["go", "rust", "zig"]);
    expect(cells.getByRole("img", { name: "1 more tag" })).toBeDefined();
    expect((row as HTMLElement).querySelector("img:not([src^='/api/v1/favicons/'])")).toBeNull();
  });
});
