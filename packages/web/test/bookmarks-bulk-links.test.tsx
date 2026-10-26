import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { previewAddTags } from "../src/bookmarks/bookmarks.ts";
import type { ApiClient } from "../src/api/client.ts";
import { allowSlowRender, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The folder and tag actions of the bulk bar (doc 03 section 3.4, doc 02 section 5.8) against a server that keeps its own
// bookmarks. The failure scenarios are a change that waits for the server instead of showing at once, a failed request that
// leaves the change in the list or reports success, an Add tags that is sent without the preview of the merged set being
// shown, an Undo that files in the folder a bookmark that was never in it, a result that hides the skipped count, a picker
// that takes a failed list for "no folders", and an action that can be started again while one runs.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type BookmarkFolder = ComponentTypes["schemas"]["BookmarkFolder"];
type BookmarkTag = ComponentTypes["schemas"]["BookmarkTag"];

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const LIST = "/api/v1/bookmarks";
const WORK = "0192f3a0-dddd-7000-8000-000000000001";
const READING = "0192f3a0-dddd-7000-8000-000000000002";
const TAG_GO = "0192f3a0-eeee-7000-8000-000000000001";
const TAG_RUST = "0192f3a0-eeee-7000-8000-000000000002";

const FOLDER_WORK: BookmarkFolder = { id: WORK, name: "Work", icon: "folder", color: 2 };
const FOLDER_READING: BookmarkFolder = { id: READING, name: "Reading", icon: "book-open", color: 5 };
const GO: BookmarkTag = { id: TAG_GO, name: "go" };
const RUST: BookmarkTag = { id: TAG_RUST, name: "rust" };

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
    tags: [],
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

interface BulkBody {
  action: string;
  ids: string[];
  folderId?: string;
  tagIds?: string[];
}

interface World {
  bookmarks: Bookmark[];
  folders: BookmarkFolder[];
  tags: BookmarkTag[];
  /** The identifiers the folder filter of the select-all companion answers: the bookmarks in the folder. */
  members: string[];
  /** Answers the bulk request; the default does what the API does and counts every named bookmark. */
  bulk: (body: BulkBody) => Response | Promise<Response>;
  preview: (body: BulkBody) => Response | Promise<Response>;
  foldersStatus: number;
  /** Makes the list unreadable, so that what it shows is what the page itself holds and not what the server says. */
  listFails: boolean;
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let world: World;
let calls: Call[] = [];

function result(requested: number, affected = requested): Response {
  return json({ requested, affected, skipped: requested - affected, skippedReasons: { not_owner: 0, not_found: requested - affected } });
}

/** What the API does to the bookmarks of the request, so that a list read after it shows the truth. */
function applied(body: BulkBody): Response {
  const chosen = new Set(body.ids);
  world.bookmarks = world.bookmarks.map((item) => {
    if (!chosen.has(item.id)) {
      return item;
    }
    const folder = world.folders.find(({ id }) => id === body.folderId);
    const tags = world.tags.filter(({ id }) => body.tagIds?.includes(id) === true);
    switch (body.action) {
      case "add_to_folder":
        return folder === undefined || item.folders.some(({ id }) => id === folder.id) ? item : { ...item, folders: [...item.folders, folder] };
      case "remove_from_folder":
        return { ...item, folders: item.folders.filter(({ id }) => id !== body.folderId) };
      case "add_tags":
        return { ...item, tags: [...item.tags, ...tags.filter(({ id }) => !item.tags.some((own) => own.id === id))].sort((a, b) => a.name.localeCompare(b.name)) };
      case "remove_tags":
        return { ...item, tags: item.tags.filter(({ id }) => body.tagIds?.includes(id) !== true) };
      default:
        return item;
    }
  });
  return result(body.ids.length);
}

function previewOf(body: BulkBody): Response {
  const named = world.bookmarks.filter(({ id }) => body.ids.includes(id));
  const tags = world.tags
    .filter(({ id }) => body.tagIds?.includes(id) === true || named.some((item) => item.tags.some((own) => own.id === id)))
    .map((tag) => ({
      id: tag.id,
      name: tag.name,
      bookmarkCount: named.filter((item) => item.tags.some((own) => own.id === tag.id) || body.tagIds?.includes(tag.id) === true).length,
      added: body.tagIds?.includes(tag.id) === true ? named.filter((item) => !item.tags.some((own) => own.id === tag.id)).length : 0,
    }));
  return json({ requested: body.ids.length, affected: named.length, skipped: body.ids.length - named.length, skippedReasons: { not_owner: 0, not_found: body.ids.length - named.length }, tags });
}

function reset(): void {
  world = {
    bookmarks: [bookmark(1), bookmark(2), bookmark(3)],
    folders: [FOLDER_WORK, FOLDER_READING],
    tags: [GO, RUST],
    members: [],
    bulk: applied,
    preview: previewOf,
    foldersStatus: 200,
    listFails: false,
  };
  calls = [];
}

function page(items: readonly unknown[]): Response {
  return json({ items, nextCursor: null, total: items.length });
}

function serve(): void {
  vi.stubGlobal("fetch", (request: Request) =>
    signedIn(request, async () => {
      const { pathname } = new URL(request.url);
      const body: unknown = request.method === "POST" ? await request.clone().json() : undefined;
      calls.push({ method: request.method, path: pathname, body });
      if (pathname === LIST) {
        return world.listFails ? problem(503, "internal_error", "req-list") : page(world.bookmarks);
      }
      if (pathname === "/api/v1/folders") {
        return world.foldersStatus === 200
          ? page(world.folders.map((folder) => ({ ...folder, ownerId: OWNER, bookmarkCount: 0, version: 1, createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" })))
          : problem(world.foldersStatus, "internal_error", "req-folders");
      }
      if (pathname === "/api/v1/tags") {
        return page(world.tags.map((tag) => ({ ...tag, bookmarkCount: 0, createdAt: "2026-10-01T08:00:00.000Z" })));
      }
      if (pathname === `${LIST}/ids`) {
        return json({ ids: world.members, truncated: false });
      }
      if (pathname === `${LIST}/bulk`) {
        return world.bulk(body as BulkBody);
      }
      if (pathname === `${LIST}/bulk/preview`) {
        return world.preview(body as BulkBody);
      }
      throw new Error(`unexpected call ${request.method} ${pathname}`);
    }),
  );
}

function to(path: string): Call[] {
  return calls.filter((call) => call.method === "POST" && call.path === path);
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
});

afterAll(() => {
  restoreWait();
});

beforeEach(() => {
  reset();
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  serve();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openApp(): Promise<void> {
  window.history.replaceState(null, "", "/bookmarks");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("link", { name: "Bookmark 1" });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function select(...numbers: number[]): Promise<void> {
  for (const n of numbers) {
    await press(screen.getByRole("checkbox", { name: `Select Bookmark ${String(n)}` }));
  }
}

function bar(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Selected bookmarks" });
}

async function openAction(name: string, title: string): Promise<HTMLElement> {
  await press(within(bar()).getByRole("button", { name }));
  return screen.findByRole("dialog", { name: title });
}

async function choose(dialog: HTMLElement, field: string, option: string): Promise<void> {
  const input = within(dialog).getByRole("combobox", { name: field });
  await act(async () => {
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
  const item = await screen.findByRole("option", { name: option, hidden: true });
  await act(async () => {
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    await Promise.resolve();
  });
  if (field === "Tags") {
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });
  }
  await waitFor(() => {
    expect(document.querySelector("[data-slot='picker-popup'], [data-slot='multi-pick-popup']")).toBeNull();
  });
}

/** The live region of the page, which the toasts' own region is not. */
function liveRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>("p.sr-only[role='status']");
  expect(region).not.toBeNull();
  return region as HTMLElement;
}

function card(n: number): HTMLElement {
  const item = screen.getByRole("link", { name: `Bookmark ${String(n)}` }).closest("[data-item-id]");
  expect(item).not.toBeNull();
  return item as HTMLElement;
}

function dotsOf(n: number): string[] {
  return within(card(n))
    .queryAllByRole("img")
    .map((dot) => dot.getAttribute("aria-label") ?? "");
}

function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe("adding to a folder", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the folder on the bookmarks at once, locks the bar until the answer, and states the counts", async () => {
    const held = gate();
    world.bulk = async (body) => {
      await held.wait;
      return applied(body);
    };
    await openApp();
    await select(1, 2);

    const dialog = await openAction("Add to folder", "Add 2 bookmarks to a folder");
    expect(within(dialog).getByRole("button", { name: "Add to folder" }).hasAttribute("disabled")).toBe(true);
    await choose(dialog, "Folder", "Reading");
    await press(within(dialog).getByRole("button", { name: "Add to folder" }));

    await waitFor(() => {
      expect(to(`${LIST}/bulk`)).toHaveLength(1);
    });
    expect(to(`${LIST}/bulk`)[0]?.body).toEqual({ action: "add_to_folder", ids: [idOf(1), idOf(2)], folderId: READING });
    // The change is in the list before the server has answered.
    await waitFor(() => {
      expect(dotsOf(1)).toEqual(["Reading"]);
    });
    expect(dotsOf(2)).toEqual(["Reading"]);
    expect(dotsOf(3)).toEqual([]);
    const busyBar = document.querySelector<HTMLElement>("[data-slot='bulk-bar']") as HTMLElement;
    expect(busyBar.getAttribute("aria-busy")).toBe("true");
    expect(within(busyBar).getByRole("button", { name: "Add tags", hidden: true }).getAttribute("aria-disabled")).toBe("true");
    expect(within(busyBar).getByRole("button", { name: /^Add to folder/, hidden: true }).hasAttribute("data-loading")).toBe(true);

    await act(async () => {
      held.open();
      await held.wait;
    });
    await waitFor(() => {
      expect(screen.queryByRole("toolbar")).toBeNull();
    });
    expect(liveRegion().textContent).toBe("2 bookmarks added to “Reading”.");
    expect((await screen.findAllByText("2 bookmarks added to “Reading”.")).length).toBeGreaterThan(1);
    // The list read after the change holds the same.
    await waitFor(() => {
      expect(calls.filter((call) => call.method === "GET" && call.path === LIST).length).toBeGreaterThan(1);
    });
    expect(dotsOf(1)).toEqual(["Reading"]);
  });

  it("puts the list back, with the list unreadable afterwards, and tells the member when the request fails, and keeps the selection", async () => {
    world.bulk = () => {
      world.listFails = true;
      return problem(429, "rate_limited", "req-bulk");
    };
    await openApp();
    await select(1, 2);
    const dialog = await openAction("Add to folder", "Add 2 bookmarks to a folder");
    await choose(dialog, "Folder", "Work");

    await press(within(dialog).getByRole("button", { name: "Add to folder" }));

    expect((await screen.findAllByText("The bookmarks could not be added to the folder. Nothing was changed. Try again in a moment.")).length).toBeGreaterThan(0);
    expect(liveRegion().textContent).toBe("The bookmarks could not be added to the folder. Nothing was changed. Try again in a moment.");
    await waitFor(() => {
      expect(dotsOf(1)).toEqual([]);
    });
    expect(dotsOf(2)).toEqual([]);
    expect(within(bar()).getByText("2 selected")).toBeDefined();
    expect(screen.queryByText(/bookmarks added to/)).toBeNull();
  });

  it("states the skipped count beside the affected count", async () => {
    world.bulk = () => result(2, 1);
    await openApp();
    await select(1, 2);
    const dialog = await openAction("Add to folder", "Add 2 bookmarks to a folder");
    await choose(dialog, "Folder", "Work");

    await press(within(dialog).getByRole("button", { name: "Add to folder" }));

    await waitFor(() => {
      expect(liveRegion().textContent).toBe("1 bookmark added to “Work”. 1 bookmark was skipped because it no longer exists or can’t be changed.");
    });
  });

  it("says so, instead of offering no folders, when the folders cannot be read, and sends nothing", async () => {
    world.foldersStatus = 503;
    await openApp();
    await select(1);

    const dialog = await openAction("Add to folder", "Add 1 bookmark to a folder");

    expect(await within(dialog).findByText("Your folders could not be loaded.")).toBeDefined();
    expect(within(dialog).queryByText("You have no folders yet.")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Add to folder" }).hasAttribute("disabled")).toBe(true);
    expect(to(`${LIST}/bulk`)).toHaveLength(0);
  });

  it("says the member has no folders when the list is empty", async () => {
    world.folders = [];
    await openApp();
    await select(1);
    const dialog = await openAction("Add to folder", "Add 1 bookmark to a folder");
    const input = within(dialog).getByRole("combobox", { name: "Folder" });

    await act(async () => {
      fireEvent.pointerDown(input);
      fireEvent.mouseDown(input);
      fireEvent.click(input);
      await Promise.resolve();
    });

    expect(await screen.findByText("You have no folders yet.")).toBeDefined();
  });
});

describe("removing from a folder", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("offers Undo, which files in the folder again only the bookmarks the removal took out of it", async () => {
    world.bookmarks = [bookmark(1, { folders: [FOLDER_READING] }), bookmark(2), bookmark(3, { folders: [FOLDER_READING] })];
    world.members = [idOf(1), idOf(3)];
    await openApp();
    await select(1, 2);

    const dialog = await openAction("Remove from folder", "Remove 2 bookmarks from a folder");
    await choose(dialog, "Folder", "Reading");
    await press(within(dialog).getByRole("button", { name: "Remove from folder" }));

    await waitFor(() => {
      expect(to(`${LIST}/bulk`)).toHaveLength(1);
    });
    expect(to(`${LIST}/bulk`)[0]?.body).toEqual({ action: "remove_from_folder", ids: [idOf(1), idOf(2)], folderId: READING });
    await waitFor(() => {
      expect(dotsOf(1)).toEqual([]);
    });
    expect(dotsOf(3)).toEqual(["Reading"]);
    expect(liveRegion().textContent).toBe("2 bookmarks removed from “Reading”.");
    const undo = await screen.findByRole("button", { name: "Undo" });

    await press(undo);

    await waitFor(() => {
      expect(to(`${LIST}/bulk`)).toHaveLength(2);
    });
    expect(to(`${LIST}/bulk`)[1]?.body).toEqual({ action: "add_to_folder", ids: [idOf(1)], folderId: READING });
    expect((await screen.findAllByText("1 bookmark put back in “Reading”.")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(dotsOf(1)).toEqual(["Reading"]);
    });
    expect(dotsOf(2)).toEqual([]);
  });

  it("offers no Undo when it cannot tell which bookmarks were in the folder", async () => {
    world.bookmarks = [bookmark(1, { folders: [FOLDER_READING] }), bookmark(2)];
    vi.stubGlobal("fetch", (request: Request) =>
      signedIn(request, async () => {
        const { pathname } = new URL(request.url);
        if (pathname === `${LIST}/ids`) {
          return problem(503, "internal_error", "req-ids");
        }
        if (pathname === LIST) {
          return page(world.bookmarks);
        }
        if (pathname === "/api/v1/folders") {
          return page([{ ...FOLDER_READING, ownerId: OWNER, bookmarkCount: 0, version: 1, createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" }]);
        }
        if (pathname === "/api/v1/tags") {
          return page([]);
        }
        if (pathname === `${LIST}/bulk`) {
          return applied((await request.json()) as BulkBody);
        }
        throw new Error(`unexpected call ${request.method} ${pathname}`);
      }),
    );
    await openApp();
    await select(1);
    const dialog = await openAction("Remove from folder", "Remove 1 bookmark from a folder");
    await choose(dialog, "Folder", "Reading");

    await press(within(dialog).getByRole("button", { name: "Remove from folder" }));

    expect((await screen.findAllByText("1 bookmark removed from “Reading”.")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("adding tags", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the merged tag set first, and adds the tags only once it is shown", async () => {
    world.bookmarks = [bookmark(1, { tags: [GO] }), bookmark(2), bookmark(3)];
    const held = gate();
    world.preview = async (body) => {
      await held.wait;
      return previewOf(body);
    };
    await openApp();
    await select(1, 2);

    const dialog = await openAction("Add tags", "Add tags to 2 bookmarks");
    expect(within(dialog).queryByText("Tags after adding")).toBeNull();
    await choose(dialog, "Tags", "rust");

    await waitFor(() => {
      expect(to(`${LIST}/bulk/preview`)).toHaveLength(1);
    });
    expect(to(`${LIST}/bulk/preview`)[0]?.body).toEqual({ action: "add_tags", ids: [idOf(1), idOf(2)], tagIds: [TAG_RUST] });
    // The wait for the preview is shown, and the action cannot be sent meanwhile.
    expect(within(dialog).getByText("Working out the tags these bookmarks will have")).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Add tags" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      held.open();
      await held.wait;
    });
    const preview = await within(dialog).findByRole("region", { name: "Tags after adding" });
    expect(within(preview).getByText("2 bookmarks will get these tags.")).toBeDefined();
    const lines = within(preview)
      .getAllByRole("listitem")
      .map((line) => line.textContent);
    expect(lines).toEqual(["go1 bookmark, 0 new", "rust2 bookmarks, 2 new"]);
    expect(to(`${LIST}/bulk`)).toHaveLength(0);

    await press(within(dialog).getByRole("button", { name: "Add tags" }));

    await waitFor(() => {
      expect(to(`${LIST}/bulk`)).toHaveLength(1);
    });
    expect(to(`${LIST}/bulk`)[0]?.body).toEqual({ action: "add_tags", ids: [idOf(1), idOf(2)], tagIds: [TAG_RUST] });
    await waitFor(() => {
      expect(within(card(2)).getByText("rust")).toBeDefined();
    });
    expect(liveRegion().textContent).toBe("Tags added to 2 bookmarks.");
    expect(within(card(3)).queryByText("rust")).toBeNull();
  });

  it("tells the member when the preview fails, lets them retry, and does not add tags without it", async () => {
    let failing = true;
    world.preview = (body) => (failing ? problem(503, "internal_error", "req-preview") : previewOf(body));
    await openApp();
    await select(1);
    const dialog = await openAction("Add tags", "Add tags to 1 bookmark");
    await choose(dialog, "Tags", "go");

    expect(await within(dialog).findByText("The preview could not be loaded.")).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Add tags" }).hasAttribute("disabled")).toBe(true);
    failing = false;
    await press(within(dialog).getByRole("button", { name: "Try again" }));

    expect(await within(dialog).findByText("1 bookmark will get these tags.")).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Add tags" }).hasAttribute("disabled")).toBe(false);
    expect(to(`${LIST}/bulk`)).toHaveLength(0);
  });

  it("sends the preview in turns for a long selection and adds the turns up", async () => {
    const asked: number[] = [];
    const api = {
      POST: (_path: string, init: { body: { ids: string[] } }) => {
        asked.push(init.body.ids.length);
        return Promise.resolve({
          data: {
            requested: init.body.ids.length,
            affected: init.body.ids.length,
            skipped: 0,
            skippedReasons: { not_owner: 0, not_found: 0 },
            tags: [{ id: TAG_GO, name: "go", bookmarkCount: init.body.ids.length, added: 1 }],
          },
        });
      },
    } as unknown as ApiClient;
    const ids = Array.from({ length: 2500 }, (_, index) => idOf(index + 1));

    const merged = await previewAddTags(api, ids, [TAG_GO]);

    expect(asked).toEqual([1000, 1000, 500]);
    expect(merged).toEqual({ requested: 2500, affected: 2500, skipped: 0, tags: [{ id: TAG_GO, name: "go", bookmarkCount: 2500, added: 3 }] });
  });
});

describe("removing tags", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("takes the tags off at once without a preview, and rolls them back on a failure", async () => {
    world.bookmarks = [bookmark(1, { tags: [GO, RUST] }), bookmark(2, { tags: [RUST] }), bookmark(3)];
    world.bulk = () => {
      world.listFails = true;
      return problem(429, "rate_limited", "req-bulk");
    };
    await openApp();
    await select(1, 2);
    const dialog = await openAction("Remove tags", "Remove tags from 2 bookmarks");
    await choose(dialog, "Tags", "rust");
    expect(within(dialog).queryByText("Tags after adding")).toBeNull();

    await press(within(dialog).getByRole("button", { name: "Remove tags" }));

    expect((await screen.findAllByText("The tags could not be removed. Nothing was changed. Try again in a moment.")).length).toBeGreaterThan(0);
    expect(to(`${LIST}/bulk/preview`)).toHaveLength(0);
    expect(to(`${LIST}/bulk`)[0]?.body).toEqual({ action: "remove_tags", ids: [idOf(1), idOf(2)], tagIds: [TAG_RUST] });
    // The tag was off the cards while the request ran and is back once it failed.
    await waitFor(() => {
      expect(within(card(2)).getByText("rust")).toBeDefined();
    });
    expect(within(card(1)).getByText("rust")).toBeDefined();
    expect(within(bar()).getByText("2 selected")).toBeDefined();
  });

  it("removes the tags from the cards and states the counts", async () => {
    world.bookmarks = [bookmark(1, { tags: [GO, RUST] }), bookmark(2, { tags: [RUST] }), bookmark(3)];
    world.bulk = (body) => {
      applied(body);
      return result(2, 2);
    };
    await openApp();
    await select(1, 2);
    const dialog = await openAction("Remove tags", "Remove tags from 2 bookmarks");
    await choose(dialog, "Tags", "rust");

    await press(within(dialog).getByRole("button", { name: "Remove tags" }));

    await waitFor(() => {
      expect(liveRegion().textContent).toBe("Tags removed from 2 bookmarks.");
    });
    expect(within(card(1)).queryByText("rust")).toBeNull();
    expect(within(card(1)).getByText("go")).toBeDefined();
    expect(within(card(2)).queryByText("rust")).toBeNull();
  });
});
