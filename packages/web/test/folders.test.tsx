import { CreateFolderRequestSchema, FOLDER_COLOR_MAX, FOLDER_ICONS, UpdateFolderRequestSchema, type ComponentTypes } from "@slugbase/contracts";
import { FOLDER_ICON_COMPONENTS } from "@slugbase/ui/patterns";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The folders page (doc 03 section 6, doc 02 section 7.1) through the app's own API client, against a stubbed transport that
// keeps the folders the way the API does: the list in the order and the page asked for, a name unique without regard to case
// (409), a change only against the version read (412), and a body that must pass the contract's own schemas (422). The
// failure scenarios are a sort that does not reach the address or the request, a delete sent without the confirmation or
// with a count that is not the folder's, a name the API refused shown as saved, a failed list shown as "no folders", a
// create that is sent with fields the member did not choose, a change that overwrites a version it did not read, a
// folder name rendered as markup, and a shortcut or link that does not reach the page.

type Folder = ComponentTypes["schemas"]["Folder"];
type Transport = (request: Request) => Promise<Response>;

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const LIST = "/api/v1/folders";

function folder(n: number, overrides: Partial<Folder> = {}): Folder {
  return {
    id: `0192f3a0-dddd-7000-8000-${String(n).padStart(12, "0")}`,
    ownerId: OWNER,
    name: `Folder ${String(n)}`,
    icon: "folder",
    color: 1,
    bookmarkCount: 0,
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: `2026-10-0${String(Math.min(n, 9))}T08:00:00.000Z`,
    ...overrides,
  };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly ifMatch: string | null;
  readonly body: unknown;
}

interface Answers {
  /** Replaces the answer to the list. */
  readonly list?: () => Promise<Response> | Response;
  /** Whether the workspace may share (both sharing entitlements); not by default, so a workspace that cannot share shows no scopes. */
  readonly sharing?: boolean;
  /** Answers the list of the shared scope with a failure, as a server that is down for that read does. */
  readonly failShared?: boolean;
  /** The status the change, creation or deletion is refused with, with the code of its problem. */
  readonly refuse?: { readonly method: "POST" | "PATCH" | "DELETE"; readonly status: number; readonly code: string };
}

interface Server {
  readonly calls: Call[];
  readonly folders: Folder[];
  readonly lists: () => Call[];
  readonly to: (method: string) => Call[];
}

function sorted(folders: readonly Folder[], sort: string): Folder[] {
  const byName = (a: Folder, b: Folder): number => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  const copy = [...folders];
  if (sort === "count") {
    return copy.sort((a, b) => b.bookmarkCount - a.bookmarkCount || byName(a, b));
  }
  if (sort === "updated") {
    return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return copy.sort(byName);
}

function taken(folders: readonly Folder[], name: string, except?: string): boolean {
  return folders.some((other) => other.id !== except && other.name.toLowerCase() === name.trim().toLowerCase());
}

/** A signed-in server that holds `initial` as the caller's folders and answers the folder operations as the API does. */
function stubServer(initial: readonly Folder[], answers: Answers = {}): Server {
  const folders = [...initial];
  const calls: Call[] = [];
  let created = 100;
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) =>
      signedIn(request, async (other) => {
        const url = new URL(other.url);
        const isFolders = url.pathname === LIST || url.pathname.startsWith(`${LIST}/`);
        if (url.pathname === "/api/v1/bookmarks" && other.method === "GET") {
          return json({ items: [], nextCursor: null, total: 0 });
        }
        if (url.pathname === "/api/v1/entitlements") {
          const sharing = answers.sharing === true;
          return json({
            entitlements: { "bookmarks.max": "unlimited", "seats.max": "unlimited", "workspaces.ownMax": "unlimited", "ai.suggestions": true, "sharing.members": sharing, "sharing.teams": sharing, "members.invite": true, "teams.manage": true, "audit.log": true },
            usage: { "bookmarks.used": 0, "seats.used": 1, "workspaces.owned": 1 },
            upgradeAvailable: false,
          });
        }
        if (!isFolders) {
          return problem(404, "not_found", "req-404");
        }
        const text = other.method === "GET" || other.method === "DELETE" ? "" : await other.clone().text();
        const body: unknown = text === "" ? undefined : JSON.parse(text);
        calls.push({ method: other.method, path: url.pathname, params: url.searchParams, ifMatch: other.headers.get("If-Match"), body });
        const refused = answers.refuse;
        if (refused !== undefined && refused.method === other.method) {
          return problem(refused.status, refused.code, "req-refused");
        }
        const id = url.pathname.slice(LIST.length + 1);
        const target = folders.find((candidate) => candidate.id === id);
        if (url.pathname === LIST && other.method === "GET") {
          if (answers.list !== undefined) {
            return answers.list();
          }
          const limit = Number(url.searchParams.get("limit") ?? "50");
          const offset = Number(url.searchParams.get("cursor") ?? "0");
          const scope = url.searchParams.get("scope");
          if (scope === "shared" && answers.failShared === true) {
            return problem(503, "service_unavailable", "req-503");
          }
          const visible = folders.filter((candidate) => scope === null || scope === "all" || (scope === "mine") === (candidate.ownerId === OWNER));
          const all = sorted(visible, url.searchParams.get("sort") ?? "name");
          const next = offset + limit;
          return json({ items: all.slice(offset, next), nextCursor: next < all.length ? String(next) : null, total: all.length });
        }
        if (url.pathname === LIST && other.method === "POST") {
          const parsed = CreateFolderRequestSchema.safeParse(body);
          if (!parsed.success) {
            return problem(422, "validation_failed", "req-422");
          }
          if (taken(folders, parsed.data.name)) {
            return problem(409, "name_taken", "req-409");
          }
          created += 1;
          const made = folder(created, { name: parsed.data.name.trim(), icon: parsed.data.icon ?? "folder", color: parsed.data.color ?? 1, version: 1 });
          folders.push(made);
          return json(made, { status: 201 });
        }
        if (target === undefined) {
          return problem(404, "not_found", "req-404");
        }
        if (other.method === "PATCH") {
          const parsed = UpdateFolderRequestSchema.safeParse(body);
          if (!parsed.success) {
            return problem(422, "validation_failed", "req-422");
          }
          if (other.headers.get("If-Match") !== `"${String(target.version)}"`) {
            return problem(412, "precondition_failed", "req-412");
          }
          if (parsed.data.name !== undefined && taken(folders, parsed.data.name, target.id)) {
            return problem(409, "name_taken", "req-409");
          }
          const changed = { ...target, ...parsed.data, version: target.version + 1 };
          folders.splice(folders.indexOf(target), 1, changed);
          return json(changed);
        }
        if (other.method === "DELETE") {
          folders.splice(folders.indexOf(target), 1);
          return new Response(null, { status: 204 });
        }
        return problem(404, "not_found", "req-404");
      }),
    ),
  );
  return {
    calls,
    folders,
    lists: () => calls.filter((call) => call.method === "GET" && call.path === LIST),
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

/** Queries for the text of the page itself: the sidebar lists the same folders by name, and a name found twice is not found. */
const inPage = {
  findByText: async (text: string | RegExp): Promise<HTMLElement> => within(await screen.findByRole("main")).findByText(text),
  getByText: (text: string | RegExp): HTMLElement => within(screen.getByRole("main")).getByText(text),
};

function namesShown(): string[] {
  // An open overlay hides the page behind it from assistive technology, which the queries respect unless told otherwise.
  const table = screen.getByRole("table", { name: "Folders", hidden: true });
  return within(table)
    .getAllByRole("row", { hidden: true })
    .slice(1)
    .map((row) => within(row).getAllByRole("cell", { hidden: true })[0]?.textContent ?? "");
}

function rowOf(name: string): HTMLElement {
  const row = inPage.getByText(name).closest("tr");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

/** The header's New folder button of a page with no folders; the empty state offers a second one once the list is read. */
async function openEmptyPage(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 2, name: "No folders yet" });
  const button = screen.getAllByRole("button", { name: "New folder" })[0];
  expect(button).toBeDefined();
  return button as HTMLElement;
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

async function chooseIcon(name: string): Promise<void> {
  await act(async () => {
    const input = within(screen.getByRole("dialog")).getByRole("combobox", { name: "Icon" });
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
  await act(async () => {
    const item = await screen.findByRole("option", { name });
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    await Promise.resolve();
  });
}

async function type(dialog: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: name } });
    await Promise.resolve();
  });
}

describe("reaching the page", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is the Folders link of the sidebar, and lists the folders by name with their icon, count and date", async () => {
    const server = stubServer([folder(2, { name: "Reading", bookmarkCount: 12, icon: "book-open", color: 3 }), folder(1, { name: "Archive", bookmarkCount: 1 })]);
    await openApp("/");

    await press(await screen.findByRole("link", { name: "Folders" }));

    await screen.findByRole("heading", { level: 1, name: "Folders" });
    expect(window.location.pathname).toBe("/folders");
    expect(screen.getByRole("link", { name: "Folders" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Folders");
    expect(namesShown()).toEqual(["Archive", "Reading"]);
    expect(within(rowOf("Reading")).getByText("12 bookmarks")).toBeDefined();
    expect(within(rowOf("Archive")).getByText("1 bookmark")).toBeDefined();
    const glyph = rowOf("Reading").querySelector("svg");
    expect(glyph?.getAttribute("class")).toContain("text-folder-3");
    expect(glyph?.closest("[aria-hidden='true']")).not.toBeNull();
    // The sidebar's read, to the end of the list, and the page's own.
    expect(server.lists()).toHaveLength(2);
    for (const list of server.lists()) {
      expect(list.params.get("sort")).toBe("name");
      expect(list.params.get("limit")).toBe("50");
      expect(list.params.get("scope")).toBe("mine");
    }
  });

  it("goes there with G then F from another page, and says so in the shortcut sheet", async () => {
    stubServer([folder(1)]);
    await openApp("/");
    await screen.findByRole("heading", { level: 1 });

    await key({ key: "g" });
    await key({ key: "f" });

    await screen.findByRole("heading", { level: 1, name: "Folders" });
    expect(window.location.pathname).toBe("/folders");

    await key({ key: "?", shiftKey: true });
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).getByText("Go to Folders")).toBeDefined();
    expect(within(sheet).getByText("New folder (on the Folders page)")).toBeDefined();
  });

  it("offers no Mine and Shared with me scopes while there is no sharing", async () => {
    stubServer([folder(1)]);
    await openApp("/folders");
    await inPage.findByText("Folder 1");

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText("Shared with me")).toBeNull();
    expect(screen.queryByText("Mine")).toBeNull();
  });

  it("is in German with the account's language", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer([folder(1, { name: "Lesen", bookmarkCount: 9 })]);
    await openApp("/folders");

    await screen.findByRole("heading", { level: 1, name: "Ordner" });
    expect(screen.getByRole("button", { name: "Neuer Ordner" })).toBeDefined();
    expect(inPage.getByText("9 Lesezeichen")).toBeDefined();
    await press(screen.getByRole("button", { name: "Aktionen für Lesen" }));
    await press(await screen.findByRole("menuitem", { name: "Löschen" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain("Die 9 Lesezeichen bleiben erhalten; nur der Ordner wird gelöscht.");
  });
});

describe("the sort", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is read from the address into the request and the control, and an unknown one is dropped", async () => {
    const server = stubServer([folder(1, { name: "Few", bookmarkCount: 1 }), folder(2, { name: "Many", bookmarkCount: 40 })]);
    await openApp("/folders?sort=count");

    await inPage.findByText("Many");

    expect(server.lists()[0]?.params.get("sort")).toBe("count");
    expect(namesShown()).toEqual(["Many", "Few"]);
    expect(screen.getByRole("combobox", { name: "Sort by" }).textContent).toContain("Bookmarks");
  });

  it("drops a sort that is none of the allowed ones instead of sending it", async () => {
    const server = stubServer([folder(1)]);
    await openApp("/folders?sort=bogus");

    await inPage.findByText("Folder 1");

    expect(server.lists()[0]?.params.get("sort")).toBe("name");
  });

  it("takes the order from the control, keeps it linkable and orders by the last change", async () => {
    const server = stubServer([folder(1, { name: "Old", updatedAt: "2026-09-01T08:00:00.000Z" }), folder(2, { name: "Newer", updatedAt: "2026-10-05T08:00:00.000Z" })]);
    await openApp("/folders");
    await inPage.findByText("Old");
    expect(namesShown()).toEqual(["Newer", "Old"]);

    await chooseOption("Sort by", "Recently updated");

    await waitFor(() => {
      expect(window.location.search).toBe("?sort=updated");
    });
    await waitFor(() => {
      expect(server.lists().at(-1)?.params.get("sort")).toBe("updated");
    });
    await waitFor(() => {
      expect(namesShown()).toEqual(["Newer", "Old"]);
    });
    await chooseOption("Sort by", "Name");
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });
});

describe("a long list", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("loads the next page with the cursor of the last one and says how many of how many are shown", async () => {
    const many = Array.from({ length: 55 }, (_, index) => folder(index + 1, { name: `Folder ${String(index + 1).padStart(2, "0")}` }));
    const server = stubServer(many);
    await openApp("/folders");
    await inPage.findByText("Folder 01");
    expect(screen.getByText("Showing 50 of 55")).toBeDefined();
    expect(server.lists()[0]?.params.get("cursor")).toBeNull();

    await press(screen.getByRole("button", { name: "Load more" }));

    await inPage.findByText("Folder 55");
    // The sidebar reads the whole list too, so the second page is asked for twice: by the sidebar and by the button.
    expect(server.lists().map((list) => list.params.get("cursor"))).toEqual([null, null, "50", "50"]);
    expect(screen.getByText("Showing 55 of 55")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(namesShown()).toHaveLength(55);
  });
});

describe("creating a folder", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("opens from the button and from N with the name, icon and colour, and sends what was chosen", async () => {
    const server = stubServer([folder(1, { name: "Archive" })]);
    await openApp("/folders");
    await inPage.findByText("Archive");

    await key({ key: "n" });
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    expect(within(dialog).getByRole("combobox", { name: "Icon" })).toBeDefined();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(FOLDER_COLOR_MAX);
    expect(within(dialog).getByRole("radio", { name: "Periwinkle" }).getAttribute("aria-checked")).toBe("true");
    await type(dialog, "  Recipes  ");
    await chooseIcon("Rocket");
    await press(within(dialog).getByRole("radio", { name: "Green" }));
    await press(within(dialog).getByRole("button", { name: "Create folder" }));

    await waitFor(() => {
      expect(server.to("POST")).toHaveLength(1);
    });
    expect(server.to("POST")[0]?.body).toEqual({ name: "Recipes", icon: "rocket", color: 2 });
    expect(await screen.findByText("Folder created.")).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull();
    });
    await waitFor(() => {
      expect(namesShown()).toEqual(["Archive", "Recipes"]);
    });
    expect(server.lists().length).toBeGreaterThan(1);
  });

  it("opens from ?create=1 with the focus in the name field, and drops the flag from the address when the form is closed", async () => {
    stubServer([folder(1, { name: "Archive" })]);
    await openApp("/folders?sort=count&create=1");

    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    expect(screen.queryByRole("dialog", { name: "New bookmark" })).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "Name" }));
    });
    expect(window.location.search).toContain("create=1");

    await press(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull();
    });
    expect([...new URLSearchParams(window.location.search)]).toEqual([["sort", "count"]]);
  });

  it("drops the flag from the address once the folder is created", async () => {
    const server = stubServer([]);
    await openApp("/folders?create=1");
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    await type(dialog, "Recipes");

    await press(within(dialog).getByRole("button", { name: "Create folder" }));

    await waitFor(() => {
      expect(server.to("POST")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New folder" })).toBeNull();
    });
    expect(window.location.search).toBe("");
  });

  it("puts the flag in the address when the form is opened with N or the button", async () => {
    stubServer([folder(1)]);
    await openApp("/folders");
    await inPage.findByText("Folder 1");

    await key({ key: "n" });

    await screen.findByRole("dialog", { name: "New folder" });
    expect(window.location.search).toBe("?create=1");
  });

  it("sends the defaults of the form when only the name is entered", async () => {
    const server = stubServer([]);
    await openApp("/folders");
    await press(await openEmptyPage());
    const dialog = await screen.findByRole("dialog", { name: "New folder" });

    await type(dialog, "Inbox");
    await press(within(dialog).getByRole("button", { name: "Create folder" }));

    await waitFor(() => {
      expect(server.to("POST")).toHaveLength(1);
    });
    expect(server.to("POST")[0]?.body).toEqual({ name: "Inbox", icon: "folder", color: 1 });
  });

  it("does not send a blank name and says so at the field", async () => {
    const server = stubServer([]);
    await openApp("/folders");
    await press(await openEmptyPage());
    const dialog = await screen.findByRole("dialog", { name: "New folder" });

    await type(dialog, "   ");
    await press(within(dialog).getByRole("button", { name: "Create folder" }));

    expect(await within(dialog).findByText("Enter a name for the folder.")).toBeDefined();
    expect(within(dialog).getByRole("textbox", { name: "Name" }).getAttribute("aria-invalid")).toBe("true");
    expect(server.to("POST")).toHaveLength(0);
  });

  it("shows a name the API refused as taken at the name field, keeps the form and adds no folder", async () => {
    const server = stubServer([folder(1, { name: "Recipes" })]);
    await openApp("/folders");
    await inPage.findByText("Recipes");
    await press(screen.getByRole("button", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });

    await type(dialog, "recipes");
    await press(within(dialog).getByRole("button", { name: "Create folder" }));

    expect(await within(dialog).findByText("You already have a folder with this name.")).toBeDefined();
    expect(within(dialog).getByRole("textbox", { name: "Name" }).getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByText("Folder created.")).toBeNull();
    expect(server.folders).toHaveLength(1);
    expect(namesShown()).toEqual(["Recipes"]);
    await type(dialog, "Recipes 2");
    expect(within(dialog).queryByText("You already have a folder with this name.")).toBeNull();
  });

  it("raises no error toast for a name shown as taken at the field", async () => {
    stubServer([folder(1, { name: "Recipes" })]);
    await openApp("/folders");
    await inPage.findByText("Recipes");
    await press(screen.getByRole("button", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });

    await type(dialog, "recipes");
    await press(within(dialog).getByRole("button", { name: "Create folder" }));
    await within(dialog).findByText("You already have a folder with this name.");
    expect(screen.queryByText("The change was not saved")).toBeNull();
  });

  it("raises the error toast for a server failure of the same form", async () => {
    stubServer([], { refuse: { method: "POST", status: 500, code: "internal" } });
    await openApp("/folders");
    await press(await openEmptyPage());
    const dialog = await screen.findByRole("dialog", { name: "New folder" });

    await type(dialog, "Inbox");
    await press(within(dialog).getByRole("button", { name: "Create folder" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("The folder could not be saved right now. Try again in a moment.");
    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Request ID: req-refused/).length).toBeGreaterThan(0);
  });

  it("says in the form when the API cannot be reached and keeps what was typed", async () => {
    stubServer([], { refuse: { method: "POST", status: 503, code: "service_unavailable" } });
    await openApp("/folders");
    await press(await openEmptyPage());
    const dialog = await screen.findByRole("dialog", { name: "New folder" });

    await type(dialog, "Inbox");
    await press(within(dialog).getByRole("button", { name: "Create folder" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("The folder could not be saved right now. Try again in a moment.");
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Inbox");
    expect(screen.queryByText("Folder created.")).toBeNull();
  });

  it("does not open a second form on N while the form is open", async () => {
    stubServer([folder(1)]);
    await openApp("/folders");
    await inPage.findByText("Folder 1");
    await press(screen.getByRole("button", { name: "New folder" }));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });

    await key({ key: "n" }, within(dialog).getByRole("textbox", { name: "Name" }));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("");
  });
});

describe("renaming and restyling", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("renames with the same form, prefilled, against the version the list holds, sending the name alone", async () => {
    const server = stubServer([folder(1, { name: "Reading", icon: "book", color: 5 })]);
    await openApp("/folders");
    await inPage.findByText("Reading");

    await chooseAction("Reading", "Rename");
    const dialog = await screen.findByRole("dialog", { name: "Rename folder" });
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Reading");
    expect(within(dialog).getByRole<HTMLInputElement>("combobox", { name: "Icon" }).value).toBe("Book");
    expect(within(dialog).getByRole("radio", { name: "Blue" }).getAttribute("aria-checked")).toBe("true");
    await type(dialog, "Long reads");
    await press(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(server.to("PATCH")).toHaveLength(1);
    });
    expect(server.to("PATCH")[0]?.ifMatch).toBe('"3"');
    expect(server.to("PATCH")[0]?.path).toBe(`${LIST}/${folder(1).id}`);
    expect(server.to("PATCH")[0]?.body).toEqual({ name: "Long reads" });
    expect(await screen.findByText("Folder saved.")).toBeDefined();
    await waitFor(() => {
      expect(namesShown()).toEqual(["Long reads"]);
    });
  });

  it("changes the icon and the colour with the same form, sending those two alone", async () => {
    const server = stubServer([folder(1, { name: "Reading" })]);
    await openApp("/folders");
    await inPage.findByText("Reading");

    await chooseAction("Reading", "Change icon and colour");
    const dialog = await screen.findByRole("dialog", { name: "Change icon and colour" });
    await chooseIcon("Moon");
    await press(within(dialog).getByRole("radio", { name: "Purple" }));
    await press(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(server.to("PATCH")).toHaveLength(1);
    });
    expect(server.to("PATCH")[0]?.body).toEqual({ icon: "moon", color: 6 });
    await waitFor(() => {
      expect(rowOf("Reading").querySelector("svg")?.getAttribute("class")).toContain("text-folder-6");
    });
  });

  it("shows a name another folder has as taken and leaves the folder as it was", async () => {
    const server = stubServer([folder(1, { name: "Reading" }), folder(2, { name: "Recipes" })]);
    await openApp("/folders");
    await inPage.findByText("Reading");
    await chooseAction("Reading", "Rename");
    const dialog = await screen.findByRole("dialog", { name: "Rename folder" });

    await type(dialog, "RECIPES");
    await press(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(await within(dialog).findByText("You already have a folder with this name.")).toBeDefined();
    expect(server.folders.map((candidate) => candidate.name)).toEqual(["Reading", "Recipes"]);
    expect(screen.queryByText("Folder saved.")).toBeNull();
    expect(screen.queryByText("The change was not saved")).toBeNull();
  });

  it("says the folder changed elsewhere when its version moved, and reads the list again", async () => {
    const server = stubServer([folder(1, { name: "Reading" })], { refuse: { method: "PATCH", status: 412, code: "precondition_failed" } });
    await openApp("/folders");
    await inPage.findByText("Reading");
    await chooseAction("Reading", "Rename");
    const dialog = await screen.findByRole("dialog", { name: "Rename folder" });
    const reads = server.lists().length;

    await type(dialog, "Long reads");
    await press(within(dialog).getByRole("button", { name: "Save changes" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("This folder was changed somewhere else.");
    expect(screen.queryByText("Folder saved.")).toBeNull();
    expect(screen.queryByText("The change was not saved")).toBeNull();
    await waitFor(() => {
      expect(server.lists().length).toBeGreaterThan(reads);
    });
  });
});

describe("deleting a folder", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks first, naming how many bookmarks stay, and deletes only on confirmation", async () => {
    const server = stubServer([folder(1, { name: "Reading", bookmarkCount: 9 }), folder(2, { name: "Zeta" })]);
    await openApp("/folders");
    await inPage.findByText("Reading");

    await chooseAction("Reading", "Delete");

    const dialog = await screen.findByRole("alertdialog", { name: "Delete “Reading”?" });
    expect(dialog.textContent).toContain("The 9 bookmarks stay; only the folder goes.");
    expect(server.to("DELETE")).toHaveLength(0);
    const reads = server.lists().length;
    await press(within(dialog).getByRole("button", { name: "Delete folder" }));

    await waitFor(() => {
      expect(server.to("DELETE")).toHaveLength(1);
    });
    expect(server.to("DELETE")[0]?.path).toBe(`${LIST}/${folder(1).id}`);
    expect(await screen.findByText("Folder deleted.")).toBeDefined();
    await waitFor(() => {
      expect(namesShown()).toEqual(["Zeta"]);
    });
    expect(server.lists().length).toBeGreaterThan(reads);
  });

  it("states the singular and the empty folder in their own words", async () => {
    stubServer([folder(1, { name: "One", bookmarkCount: 1 }), folder(2, { name: "Empty", bookmarkCount: 0 })]);
    await openApp("/folders");
    await inPage.findByText("One");

    await chooseAction("One", "Delete");
    expect((await screen.findByRole("alertdialog")).textContent).toContain("The 1 bookmark stays; only the folder goes.");
    await press(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    await chooseAction("Empty", "Delete");

    expect((await screen.findByRole("alertdialog")).textContent).toContain("No bookmarks are in this folder; only the folder goes.");
  });

  it("deletes nothing when the dialog is cancelled", async () => {
    const server = stubServer([folder(1, { name: "Reading", bookmarkCount: 9 })]);
    await openApp("/folders");
    await inPage.findByText("Reading");
    await chooseAction("Reading", "Delete");

    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(server.to("DELETE")).toHaveLength(0);
    expect(namesShown()).toEqual(["Reading"]);
  });

  it("keeps the row and says so in the dialog when the delete fails", async () => {
    const server = stubServer([folder(1, { name: "Reading" })], { refuse: { method: "DELETE", status: 503, code: "service_unavailable" } });
    await openApp("/folders");
    await inPage.findByText("Reading");
    await chooseAction("Reading", "Delete");

    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete folder" }));

    expect((await within(await screen.findByRole("alertdialog")).findByRole("alert")).textContent).toBe("The folder could not be deleted right now. Try again in a moment.");
    expect(server.to("DELETE")).toHaveLength(1);
    expect(screen.queryByText("Folder deleted.")).toBeNull();
    expect(server.folders).toHaveLength(1);
    expect(inPage.getByText("Reading")).toBeDefined();
  });
});

describe("opening a folder in Bookmarks", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("goes to the bookmark list with the folder in the address", async () => {
    stubServer([folder(1, { name: "Reading" })]);
    await openApp("/folders");
    await inPage.findByText("Reading");

    await chooseAction("Reading", "Open in Bookmarks");

    await screen.findByRole("heading", { level: 1, name: "Bookmarks" });
    expect(window.location.pathname).toBe("/bookmarks");
    expect(window.location.search).toBe(`?folderId=${folder(1).id}`);
  });
});

describe("states", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows skeleton rows while the first page is read, not an empty page, and then the folders", async () => {
    let release: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer([folder(1)], {
      list: async () => {
        await open;
        return json({ items: [folder(1)], nextCursor: null, total: 1 });
      },
    });
    await openApp("/folders");

    const wait = await screen.findByRole("status", { name: "Loading the folders" });
    expect(wait.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("No folders yet")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    await act(async () => {
      release();
      await Promise.resolve();
    });

    await inPage.findByText("Folder 1");
    expect(screen.queryByRole("status", { name: "Loading the folders" })).toBeNull();
  });

  it("teaches on an empty workspace and opens the form from its button", async () => {
    stubServer([]);
    await openApp("/folders");

    expect(await screen.findByRole("heading", { level: 2, name: "No folders yet" })).toBeDefined();
    expect(screen.getByText(/deleting a folder never deletes the bookmarks in it/)).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();
    const main = screen.getByRole("main");
    await press(within(main).getAllByRole("button", { name: "New folder" }).at(-1) as HTMLElement);

    await screen.findByRole("dialog", { name: "New folder" });
  });

  it("shows an error banner and no list when the first page cannot be read, and reads again on retry", async () => {
    let healthy = false;
    stubServer([folder(1)], {
      list: () => (healthy ? json({ items: [folder(1)], nextCursor: null, total: 1 }) : problem(503, "service_unavailable", "req-503")),
    });
    await openApp("/folders");

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("The folders could not be loaded. Try again in a moment.");
    expect(screen.queryByText("No folders yet")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();

    healthy = true;
    await press(within(banner).getByRole("button", { name: "Try again" }));

    await inPage.findByText("Folder 1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a folder name as text, never as markup", async () => {
    stubServer([folder(1, { name: "<img src=x onerror=alert(1)>" })]);
    await openApp("/folders");

    const cell = await inPage.findByText("<img src=x onerror=alert(1)>");

    expect(cell.querySelector("img")).toBeNull();
    expect(screen.getByRole("main").querySelector("img")).toBeNull();
  });
});

describe("the icon set", () => {
  it("has a component for every icon the contract allows, and the contract allows no icon the app cannot draw", () => {
    expect(Object.keys(FOLDER_ICON_COMPONENTS).sort()).toEqual([...FOLDER_ICONS].sort());
  });
});

const GRACE = "0192f3a0-bbbb-7000-8000-000000000002";

/** A folder of another member that is shared with the signed-in member: it names its owner and carries no share summary. */
function received(n: number, name: string, overrides: Partial<Folder> = {}): Folder {
  return folder(n, { name, ownerId: GRACE, owner: { accountId: GRACE, displayName: "Grace Hopper" }, shareSummary: null, ...overrides });
}

/** A folder of the signed-in member's that is shared with a team and two members, or with nobody. */
function own(n: number, name: string, shared: boolean): Folder {
  return folder(n, { name, shareSummary: shared ? { memberCount: 2, teams: [{ id: "0192f3a0-eeee-7000-8000-000000000001", name: "Design" }] } : { memberCount: 0, teams: [] } });
}

describe("folders shared with the member", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("offers the Mine and Shared with me tabs and says how each own folder is shared", async () => {
    const server = stubServer([own(1, "Notes", false), own(2, "Roadmap", true), received(3, "Reading")], { sharing: true });
    await openApp("/folders");
    await inPage.findByText("Notes");

    expect(namesShown()).toEqual(["Notes", "Roadmap"]);
    expect(within(rowOf("Notes")).getByText("Private")).toBeDefined();
    expect(within(rowOf("Roadmap")).getByText("Shared with Design team and 2 members")).toBeDefined();
    const tabs = screen.getByRole("tablist", { name: "Folders to show" });
    expect(within(tabs).getByRole("tab", { name: "Mine" }).getAttribute("aria-selected")).toBe("true");
    expect(within(tabs).getByRole("tab", { name: "Shared with me" }).getAttribute("aria-selected")).toBe("false");
    expect(server.lists().filter((call) => call.params.get("scope") === "shared").length).toBeGreaterThan(0);
  });

  it("lists the folders shared with the member at ?scope=shared, read-only, with who shared them", async () => {
    const server = stubServer([own(1, "Notes", false), received(3, "Reading", { bookmarkCount: 4 })], { sharing: true });
    await openApp("/folders?scope=shared");
    await inPage.findByText("Reading");

    expect(namesShown()).toEqual(["Reading"]);
    expect(within(rowOf("Reading")).getByText("Shared with you by Grace Hopper")).toBeDefined();
    expect(within(rowOf("Reading")).getByText("4 bookmarks")).toBeDefined();
    expect(screen.getByRole("tab", { name: "Shared with me" }).getAttribute("aria-selected")).toBe("true");
    await press(screen.getByRole("button", { name: "Actions for Reading" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Open in Bookmarks"]);
    const pageLists = server.lists().filter((call) => call.params.get("scope") === "shared");
    expect(pageLists.length).toBeGreaterThan(0);
    expect(server.to("PATCH")).toEqual([]);
    expect(server.to("DELETE")).toEqual([]);
  });

  it("moves between the tabs through the address, keeping the sort", async () => {
    const server = stubServer([own(1, "Notes", false), received(3, "Reading")], { sharing: true });
    await openApp("/folders?sort=count");
    await inPage.findByText("Notes");

    await press(screen.getByRole("tab", { name: "Shared with me" }));
    await inPage.findByText("Reading");
    expect([...new URLSearchParams(window.location.search)].sort()).toEqual([
      ["scope", "shared"],
      ["sort", "count"],
    ]);
    expect(namesShown()).toEqual(["Reading"]);
    expect(server.lists().some((call) => call.params.get("scope") === "shared" && call.params.get("sort") === "count")).toBe(true);

    await press(screen.getByRole("tab", { name: "Mine" }));
    await inPage.findByText("Notes");
    expect([...new URLSearchParams(window.location.search)]).toEqual([["sort", "count"]]);
  });

  it("has its own empty state on the shared tab, with no way to create a folder from it", async () => {
    stubServer([own(1, "Notes", false)], { sharing: true });
    await openApp("/folders?scope=shared");

    await screen.findByRole("heading", { level: 2, name: "Nothing has been shared with you yet" });
    expect(screen.queryByRole("heading", { name: "No folders yet" })).toBeNull();
    expect(within(screen.getByRole("main")).getAllByRole("button", { name: "New folder" })).toHaveLength(1);
  });

  it("hides the tabs and the sharing column where the workspace may not share, and reads no shared folders for the sidebar", async () => {
    const server = stubServer([own(1, "Notes", false), received(3, "Reading")]);
    await openApp("/folders");
    await inPage.findByText("Notes");

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Sharing" })).toBeNull();
    expect(screen.queryByText("Private")).toBeNull();
    expect(namesShown()).toEqual(["Notes"]);
    expect(server.lists().filter((call) => call.params.get("scope") === "shared")).toEqual([]);
  });

  it("lists the shared folders in the sidebar after the member's own, under their own label, and filters the bookmarks by one", async () => {
    stubServer([own(1, "Zeta", false), received(3, "Alpha shared")], { sharing: true });
    await openApp("/");
    const section = await waitForSidebarFolders();

    await within(section).findByText("Alpha shared");
    expect(within(section).getAllByRole("link").map((link) => link.textContent)).toEqual(["Zeta", "Alpha shared"]);
    expect(within(section).getByText("Shared with you")).toBeDefined();
    const link = within(section).getByRole("link", { name: "Alpha shared" });
    expect(link.getAttribute("href")).toContain(`folderId=${received(3, "Alpha shared").id}`);
  });

  it("keeps the member's own folders when the shared ones cannot be read, says so and reads them again", async () => {
    const server = stubServer([own(1, "Zeta", false), received(3, "Alpha shared")], { sharing: true, failShared: true });
    await openApp("/");
    const section = await waitForSidebarFolders();

    await within(section).findByText("The folders shared with you could not be loaded.");
    expect(within(section).getByRole("link", { name: "Zeta" })).toBeDefined();
    expect(within(section).queryByText("You have no folders yet")).toBeNull();
    const before = server.lists().length;
    await press(within(section).getByRole("button", { name: "Reload folders" }));
    await waitFor(() => {
      expect(server.lists().length).toBeGreaterThan(before);
    });
  });

  it("does not say the member has no folders while only shared ones exist", async () => {
    stubServer([received(3, "Alpha shared")], { sharing: true });
    await openApp("/");
    const section = await waitForSidebarFolders();

    await within(section).findByText("Alpha shared");
    expect(within(section).queryByText("You have no folders yet")).toBeNull();
  });

  it("is in German with the account's language", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer([own(1, "Notizen", false), received(3, "Lesen")], { sharing: true });
    await openApp("/folders?scope=shared");
    await inPage.findByText("Lesen");

    expect(within(rowOf("Lesen")).getByText("Mit dir geteilt von Grace Hopper")).toBeDefined();
    expect(screen.getByRole("tab", { name: "Mit mir geteilt" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Meine" })).toBeDefined();
  });
});

async function waitForSidebarFolders(): Promise<HTMLElement> {
  return waitFor(() => {
    const section = document.querySelector<HTMLElement>("[data-slot='sidebar-folders']");
    expect(section).not.toBeNull();
    return section as HTMLElement;
  });
}
