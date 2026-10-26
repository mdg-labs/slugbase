import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The folders and tags fields of the bookmark modal (doc 03 section 4, fields 5 and 6) against a stubbed transport. The
// failure scenarios are a folder made inline that is chosen although the creation was refused, a name the API refused
// that is not told at the field, a refused creation that is raised as a toast as well, a bookmark that is sent without the
// folders and tags chosen or with ones that were not changed, a save that fails after the inline creation and loses what
// was typed, a failed list shown as having no folders or tags, a tag name over the limit that is sent, and a folder or tag
// that is gone shown as a bookmark that is gone.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Folder = ComponentTypes["schemas"]["Folder"];
type Tag = ComponentTypes["schemas"]["Tag"];
type Transport = (request: Request) => Promise<Response>;

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const BOOKMARK_ID = "0192f3a0-aaaa-7000-8000-000000000001";
const WORK_ID = "0192f3a0-dddd-7000-8000-000000000001";
const READING_ID = "0192f3a0-dddd-7000-8000-000000000002";
const MADE_ID = "0192f3a0-dddd-7000-8000-000000000003";
const TAG_GO = "0192f3a0-eeee-7000-8000-000000000001";
const TAG_RUST = "0192f3a0-eeee-7000-8000-000000000002";

function folder(id: string, name: string): Folder {
  return { id, ownerId: OWNER, name, icon: "folder", color: 1, bookmarkCount: 0, version: 1, createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" };
}

function tag(id: string, name: string): Tag {
  return { id, name, bookmarkCount: 0, createdAt: "2026-10-01T08:00:00.000Z" };
}

const BOOKMARK: Bookmark = {
  id: BOOKMARK_ID,
  ownerId: OWNER,
  url: "https://example.com/docs",
  host: "example.com",
  title: "Example docs",
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
};

const FILED: Bookmark = {
  ...BOOKMARK,
  folders: [{ id: WORK_ID, name: "Work", icon: "folder", color: 1 }],
  tags: [{ id: TAG_GO, name: "go" }],
};

interface Answers {
  readonly folders?: (request: Request) => Promise<Response> | Response;
  readonly tags?: () => Promise<Response> | Response;
  readonly createFolder?: () => Response;
  readonly createBookmark?: () => Response;
  readonly updateBookmark?: () => Response;
  readonly bookmark?: Bookmark;
}

interface Server {
  readonly posts: unknown[];
  readonly patches: { readonly ifMatch: string | null; readonly body: unknown }[];
  readonly folderPosts: unknown[];
  readonly listCalls: (path: string) => number;
}

function stubServer(answers: Answers = {}): Server {
  const posts: unknown[] = [];
  const patches: Server["patches"] = [];
  const folderPosts: unknown[] = [];
  const reads = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) =>
      signedIn(request, async (other) => {
        const { pathname } = new URL(other.url);
        if (other.method === "GET") {
          reads.set(pathname, (reads.get(pathname) ?? 0) + 1);
        }
        if (pathname === "/api/v1/folders" && other.method === "GET") {
          return answers.folders?.(other) ?? json({ items: [folder(WORK_ID, "Work"), folder(READING_ID, "Reading list")], nextCursor: null, total: 2 });
        }
        if (pathname === "/api/v1/folders" && other.method === "POST") {
          folderPosts.push(JSON.parse(await other.clone().text()) as unknown);
          return answers.createFolder?.() ?? json(folder(MADE_ID, "Travel"), { status: 201 });
        }
        if (pathname === "/api/v1/tags" && other.method === "GET") {
          return answers.tags?.() ?? json({ items: [tag(TAG_GO, "go"), tag(TAG_RUST, "rust")], nextCursor: null, total: 2 });
        }
        if (pathname === "/api/v1/bookmarks" && other.method === "GET") {
          return json({ items: [], nextCursor: null, total: 0 });
        }
        if (pathname === "/api/v1/bookmarks" && other.method === "POST") {
          posts.push(JSON.parse(await other.clone().text()) as unknown);
          return answers.createBookmark?.() ?? json(BOOKMARK, { status: 201 });
        }
        if (pathname === `/api/v1/bookmarks/${BOOKMARK_ID}` && other.method === "GET") {
          return json(answers.bookmark ?? BOOKMARK);
        }
        if (pathname === `/api/v1/bookmarks/${BOOKMARK_ID}` && other.method === "PATCH") {
          patches.push({ ifMatch: other.headers.get("If-Match"), body: JSON.parse(await other.clone().text()) as unknown });
          return answers.updateBookmark?.() ?? json({ ...BOOKMARK, version: 4 });
        }
        return problem(404, "not_found", "req-404");
      }),
    ),
  );
  return { posts, patches, folderPosts, listCalls: (path) => reads.get(path) ?? 0 };
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
  vi.unstubAllGlobals();
});

async function openApp(path: string): Promise<HTMLElement> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  // The form, not the skeleton an edit shows while it reads the bookmark in the same overlay.
  await screen.findByLabelText("URL");
  return screen.findByRole("dialog", { name: /^(New|Edit) bookmark$/ });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function typeInto(input: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    await Promise.resolve();
  });
}

async function fill(dialog: HTMLElement): Promise<void> {
  await typeInto(within(dialog).getByLabelText("URL"), "https://example.com/docs");
  await typeInto(within(dialog).getByLabelText("Title"), "Example docs");
}

async function openField(dialog: HTMLElement, name: "Folders" | "Tags"): Promise<HTMLElement> {
  const input = await within(dialog).findByLabelText(name);
  await act(async () => {
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
  return input;
}

/** Shuts the list of a field; while it is open the overlay behind it is hidden from assistive technology, so its other controls are out of reach. */
async function closeList(input: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(input, { key: "Escape" });
    await Promise.resolve();
  });
  // The next list opens only once this one is gone: until then the page behind it, which the next list is part of, stays hidden from assistive technology.
  await waitFor(() => {
    expect(document.querySelector("[data-slot='multi-pick-popup']")).toBeNull();
  });
}

async function choose(dialog: HTMLElement, field: "Folders" | "Tags", option: string | RegExp): Promise<void> {
  const input = await openField(dialog, field);
  // jsdom ends the closing animation of the list before this one late, and until then the page behind it is marked hidden, this list's portal with it.
  await press(await screen.findByRole("option", { name: option, hidden: true }));
  await closeList(input);
}

/** Types `name` into the tags field and takes its "Create tag" item. */
async function createTag(dialog: HTMLElement, name: string): Promise<void> {
  const input = await openField(dialog, "Tags");
  await typeInto(input, name);
  await press(await screen.findByRole("option", { name: `Create tag “${name}”`, hidden: true }));
  await closeList(input);
}

function chips(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll("[data-slot='multi-pick-chip']")].map((chip) => chip.textContent);
}

async function save(dialog: HTMLElement): Promise<void> {
  await press(within(dialog).getByRole("button", { name: "Save", hidden: true }));
}

function modal(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: /^(New|Edit) bookmark$/ });
}

describe("choosing folders and tags for a new bookmark", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("sends the folders and tags chosen, the names typed as tagNames", async () => {
    const server = stubServer();
    const dialog = await openApp("/?new=1");
    await fill(dialog);

    await choose(dialog, "Folders", "Reading list");
    await choose(dialog, "Folders", "Work");
    await choose(dialog, "Tags", "rust");
    await createTag(dialog, "Zig");

    expect(chips(dialog)).toEqual(["Reading list", "Work", "rust", "Zig"]);
    await save(dialog);
    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(server.posts).toEqual([
      { url: "https://example.com/docs", title: "Example docs", folderIds: [READING_ID, WORK_ID], tagIds: [TAG_RUST], tagNames: ["Zig"] },
    ]);
  });

  it("sends neither when none is chosen", async () => {
    const server = stubServer();
    const dialog = await openApp("/?new=1");
    await fill(dialog);
    await within(dialog).findByRole("combobox", { name: "Folders" });

    await save(dialog);

    await waitFor(() => {
      expect(server.posts).toHaveLength(1);
    });
    expect(server.posts[0]).toEqual({ url: "https://example.com/docs", title: "Example docs" });
  });

  it("refuses a tag name over 40 characters at the field, which the next valid name clears, and never sends it", async () => {
    const server = stubServer();
    const dialog = await openApp("/?new=1");
    await fill(dialog);
    const tags = await openField(dialog, "Tags");
    const long = "t".repeat(41);

    await typeInto(tags, long);
    await press(await screen.findByRole("option", { name: `Create tag “${long}”` }));
    await closeList(tags);

    expect(await within(dialog).findByText("Use a tag name of at most 40 characters.")).toBeTruthy();
    expect(chips(dialog)).toEqual([]);
    await createTag(dialog, "t".repeat(40));
    expect(within(dialog).queryByText("Use a tag name of at most 40 characters.")).toBeNull();
    await save(dialog);
    await waitFor(() => {
      expect(server.posts).toHaveLength(1);
    });
    expect(server.posts[0]).toEqual({ url: "https://example.com/docs", title: "Example docs", tagNames: ["t".repeat(40)] });
  });
});

describe("creating a folder from the field", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("makes the folder through the folders request, chooses it and files the bookmark in it", async () => {
    const server = stubServer();
    const dialog = await openApp("/?new=1");
    await fill(dialog);
    const folders = await openField(dialog, "Folders");

    await typeInto(folders, "  Travel ");
    await press(await screen.findByRole("option", { name: "Create folder “Travel”" }));

    await waitFor(() => {
      expect(chips(dialog)).toEqual(["Travel"]);
    });
    await closeList(folders);
    expect(server.folderPosts).toEqual([{ name: "Travel", icon: "folder", color: 1 }]);
    expect(server.posts).toHaveLength(0);
    await save(dialog);
    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(server.posts).toEqual([{ url: "https://example.com/docs", title: "Example docs", folderIds: [MADE_ID] }]);
  });

  it("says at the field that the name is taken, keeps the modal open, chooses nothing and raises no toast", async () => {
    const server = stubServer({ createFolder: () => problem(409, "name_taken", "req-409") });
    const dialog = await openApp("/?new=1");
    await fill(dialog);
    const folders = await openField(dialog, "Folders");

    await typeInto(folders, "Travel");
    await press(await screen.findByRole("option", { name: "Create folder “Travel”" }));

    expect(await within(dialog).findByText("You already have a folder with this name. Choose it from the list.")).toBeTruthy();
    expect(chips(dialog)).toEqual([]);
    expect(modal()).not.toBeNull();
    expect(screen.queryByText("The change was not saved")).toBeNull();
    expect(within(dialog).getByLabelText<HTMLInputElement>("Title").value).toBe("Example docs");
    expect(server.posts).toHaveLength(0);
  });

  it("refreshes the folders after a name taken, so a folder the list did not show is offered", async () => {
    const server = stubServer({ createFolder: () => problem(409, "name_taken", "req-409") });
    const dialog = await openApp("/?new=1");
    const folders = await openField(dialog, "Folders");
    const before = server.listCalls("/api/v1/folders");

    await typeInto(folders, "Travel");
    await press(await screen.findByRole("option", { name: "Create folder “Travel”" }));
    await within(dialog).findByText(/You already have a folder with this name/);

    await waitFor(() => {
      expect(server.listCalls("/api/v1/folders")).toBeGreaterThan(before);
    });
  });

  it("refuses a name over the folder limit at the field without asking the API", async () => {
    const server = stubServer();
    const dialog = await openApp("/?new=1");
    const folders = await openField(dialog, "Folders");
    const long = "f".repeat(65);

    await typeInto(folders, long);
    await press(await screen.findByRole("option", { name: `Create folder “${long}”` }));

    expect(await within(dialog).findByText("Use a name of 1 to 64 characters.")).toBeTruthy();
    expect(server.folderPosts).toHaveLength(0);
    expect(chips(dialog)).toEqual([]);
  });

  it("raises the error toast for a failure it does not tell at the field, and chooses nothing", async () => {
    stubServer({ createFolder: () => problem(500, "internal", "req-500") });
    const dialog = await openApp("/?new=1");
    const folders = await openField(dialog, "Folders");

    await typeInto(folders, "Travel");
    await press(await screen.findByRole("option", { name: "Create folder “Travel”" }));

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(chips(dialog)).toEqual([]);
    expect(modal()).not.toBeNull();
  });

  it("keeps the folder chosen and everything typed when the bookmark then fails to save", async () => {
    const server = stubServer({ createBookmark: () => problem(503, "unavailable", "req-503") });
    const dialog = await openApp("/?new=1");
    await fill(dialog);
    const folders = await openField(dialog, "Folders");
    await typeInto(folders, "Travel");
    await press(await screen.findByRole("option", { name: "Create folder “Travel”" }));
    await waitFor(() => {
      expect(chips(dialog)).toEqual(["Travel"]);
    });
    await closeList(folders);
    await choose(dialog, "Tags", "go");

    await save(dialog);

    expect(await within(dialog).findByText("The bookmark could not be saved right now. Try again in a moment.")).toBeTruthy();
    expect(chips(dialog)).toEqual(["Travel", "go"]);
    expect(within(dialog).getByLabelText<HTMLInputElement>("Title").value).toBe("Example docs");
    expect(server.folderPosts).toHaveLength(1);
    await save(dialog);
    await waitFor(() => {
      expect(server.posts).toHaveLength(2);
    });
    expect(server.folderPosts).toHaveLength(1);
  });
});

describe("editing the folders and tags of a bookmark", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("preselects the folders and own tags the bookmark has, and sends nothing when they are left", async () => {
    const server = stubServer({ bookmark: FILED });
    const dialog = await openApp(`/bookmarks?bookmark=${BOOKMARK_ID}`);
    await waitFor(() => {
      expect(chips(dialog)).toEqual(["Work", "go"]);
    });

    await save(dialog);

    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(server.patches).toHaveLength(0);
  });

  it("sends the folders alone when only they changed", async () => {
    const server = stubServer({ bookmark: FILED });
    const dialog = await openApp(`/bookmarks?bookmark=${BOOKMARK_ID}`);
    await waitFor(() => {
      expect(chips(dialog)).toEqual(["Work", "go"]);
    });

    await press(within(dialog).getByRole("button", { name: "Remove Work", hidden: true }));
    await choose(dialog, "Folders", "Reading list");
    await save(dialog);

    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(server.patches).toEqual([{ ifMatch: '"3"', body: { folderIds: [READING_ID] } }]);
  });

  it("sends all the tags that stay, with the new names, when the tags changed", async () => {
    const server = stubServer({ bookmark: FILED });
    const dialog = await openApp(`/bookmarks?bookmark=${BOOKMARK_ID}`);
    await waitFor(() => {
      expect(chips(dialog)).toEqual(["Work", "go"]);
    });

    await choose(dialog, "Tags", "rust");
    await createTag(dialog, "Zig");
    await save(dialog);

    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(server.patches).toEqual([{ ifMatch: '"3"', body: { tagIds: [TAG_GO, TAG_RUST], tagNames: ["Zig"] } }]);
  });

  it("sends an empty list to take every tag off", async () => {
    const server = stubServer({ bookmark: FILED });
    const dialog = await openApp(`/bookmarks?bookmark=${BOOKMARK_ID}`);
    await waitFor(() => {
      expect(chips(dialog)).toEqual(["Work", "go"]);
    });

    await press(within(dialog).getByRole("button", { name: "Remove go", hidden: true }));
    await save(dialog);

    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(server.patches).toEqual([{ ifMatch: '"3"', body: { tagIds: [] } }]);
  });

  it("asks before closing when only the folders or tags changed", async () => {
    stubServer({ bookmark: FILED });
    const dialog = await openApp(`/bookmarks?bookmark=${BOOKMARK_ID}`);
    await waitFor(() => {
      expect(chips(dialog)).toEqual(["Work", "go"]);
    });
    await press(within(dialog).getByRole("button", { name: "Remove go", hidden: true }));

    await press(within(dialog).getByRole("button", { name: "Cancel", hidden: true }));

    expect(await screen.findByRole("alertdialog", { name: "Discard your changes?" })).toBeTruthy();
  });

  it("says a folder or tag was not found, not that the bookmark was, when the save names a choice the API does not know", async () => {
    stubServer({ bookmark: FILED, updateBookmark: () => problem(404, "not_found", "req-404") });
    const dialog = await openApp(`/bookmarks?bookmark=${BOOKMARK_ID}`);
    await waitFor(() => {
      expect(chips(dialog)).toEqual(["Work", "go"]);
    });
    await choose(dialog, "Folders", "Reading list");

    await save(dialog);

    expect(await within(dialog).findByText("A folder or tag was not found")).toBeTruthy();
    expect(within(dialog).queryByText("Bookmark not found")).toBeNull();
    expect(chips(dialog)).toEqual(["Work", "Reading list", "go"]);
  });
});

describe("the lists behind the fields", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("says the folders and tags are loading, not that there are none", async () => {
    stubServer({ folders: () => new Promise<Response>(() => undefined), tags: () => new Promise<Response>(() => undefined) });
    const dialog = await openApp("/?new=1");

    const folders = await openField(dialog, "Folders");
    expect(await screen.findByText("Loading your folders")).toBeTruthy();
    expect(screen.queryByText(/You have no folders yet/)).toBeNull();
    await closeList(folders);
    await openField(dialog, "Tags");
    expect(await screen.findByText("Loading your tags")).toBeTruthy();
    expect(screen.queryByText(/You have no tags yet/)).toBeNull();
  });

  it("says there are none once the lists were read and are empty", async () => {
    stubServer({ folders: () => json({ items: [], nextCursor: null, total: 0 }), tags: () => json({ items: [], nextCursor: null, total: 0 }) });
    const dialog = await openApp("/?new=1");

    const folders = await openField(dialog, "Folders");
    expect(await screen.findByText("You have no folders yet. Type a name to create one.")).toBeTruthy();
    await closeList(folders);
    await openField(dialog, "Tags");
    expect(await screen.findByText("You have no tags yet. Type a name to create one.")).toBeTruthy();
  });

  it("says a list could not be loaded instead of showing it empty, and reads it again on request", async () => {
    let failing = true;
    const server = stubServer({
      folders: () => (failing ? problem(503, "unavailable", "req-503") : json({ items: [folder(WORK_ID, "Work")], nextCursor: null, total: 1 })),
    });
    const dialog = await openApp("/?new=1");

    expect(await within(dialog).findByText("Your folders could not be loaded.")).toBeTruthy();
    const folders = await openField(dialog, "Folders");
    expect((await screen.findByRole("alert")).textContent).toBe("Your folders could not be loaded.");
    expect(screen.queryByText(/You have no folders yet/)).toBeNull();
    await closeList(folders);

    failing = false;
    await press(within(dialog).getByRole("button", { name: "Try again", hidden: true }));
    await waitFor(() => {
      expect(within(dialog).queryByText("Your folders could not be loaded.")).toBeNull();
    });
    await choose(dialog, "Folders", "Work");
    expect(chips(dialog)).toEqual(["Work"]);
    expect(server.listCalls("/api/v1/folders")).toBeGreaterThan(1);
  });

  it("keeps the folders the bookmark is in as chips when the list could not be loaded", async () => {
    stubServer({ bookmark: FILED, folders: () => problem(503, "unavailable", "req-503") });
    const dialog = await openApp(`/bookmarks?bookmark=${BOOKMARK_ID}`);

    await within(dialog).findByText("Your folders could not be loaded.");
    expect(chips(dialog)).toEqual(["Work", "go"]);
  });

  it("reads a list of more than one page to its end", async () => {
    const cursors: string[] = [];
    stubServer({
      folders: (request) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor ?? "");
        return cursor === null
          ? json({ items: [folder(WORK_ID, "Work")], nextCursor: "next", total: 2 })
          : json({ items: [folder(READING_ID, "Reading list")], nextCursor: null, total: 2 });
      },
    });
    const dialog = await openApp("/?new=1");

    await choose(dialog, "Folders", "Reading list");

    expect(cursors).toEqual(["", "next"]);
    expect(chips(dialog)).toEqual(["Reading list"]);
  });
});
