import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import type { ApiClient } from "../src/api/client.ts";
import { ApiProblemError } from "../src/api/client.ts";
import { deleteFormerContent, reassignFormerContent } from "../src/shell/former-content.ts";
import { json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { FORMER_CONTENT_PATH, GRACE, SELF, stubWorkspaceSettingsServer, type Role, type TestFormerBookmark, type TestFormerFolder, type WorkspaceSettingsServerOptions } from "./workspace-settings-server.ts";

// The former members' content of /settings/workspace/members (doc 03 section 11.7, doc 02 section 2.10). The failure scenarios are a plain member whose
// page asks for content only admins may read, a list that failed to load shown as the empty state, a failed next page that drops the rows already
// shown, a title or a folder name that is drawn as markup, and an empty workspace that shows two empty tables. Deleting what is selected adds: a delete that is
// drawn as done when the request failed or was rejected, a selection lost by a failure, a lists that is not read again after a deletion, and a deletion sent
// without the confirmation that states what goes. Reassigning what is selected adds: a reassignment that is drawn as done when the request failed or was rejected, a
// recipient who has left the workspace meanwhile that is reported as a failure of the whole request or not named, a selection lost by either, a confirmation that closes
// before the lists are read again, a picker that offers someone who is no member, and a move sent without the confirmation that says what it does to slugs, names and filings.

const SLOW_TEST_TIMEOUT_MS = 30_000;
const DELETE_PATH = `${FORMER_CONTENT_PATH}/delete`;
const REASSIGN_PATH = `${FORMER_CONTENT_PATH}/reassign`;
const BOOKMARKS_PATH = `${FORMER_CONTENT_PATH}/bookmarks`;
const FOLDERS_PATH = `${FORMER_CONTENT_PATH}/folders`;

const SPEC: TestFormerBookmark = {
  id: "0192f3a0-eeee-7000-8000-000000000001",
  title: "Protocol specification",
  url: "https://example.org/spec",
  host: "example.org",
  slug: "spec",
  forwarding: true,
  createdAt: "2026-09-12T08:00:00.000Z",
  updatedAt: "2026-09-12T08:00:00.000Z",
};

const PLAIN: TestFormerBookmark = {
  id: "0192f3a0-eeee-7000-8000-000000000002",
  title: "Reading list",
  url: "https://example.net/reading",
  host: "example.net",
  slug: null,
  forwarding: false,
  createdAt: "2026-09-13T08:00:00.000Z",
  updatedAt: "2026-09-13T08:00:00.000Z",
};

const HOSTILE: TestFormerBookmark = {
  id: "0192f3a0-eeee-7000-8000-000000000003",
  title: "<img src=x onerror=alert(1)>",
  url: "https://example.com/hostile",
  host: "example.com",
  slug: null,
  forwarding: false,
  createdAt: "2026-09-14T08:00:00.000Z",
  updatedAt: "2026-09-14T08:00:00.000Z",
};

const RESEARCH: TestFormerFolder = {
  id: "0192f3a0-eeee-7000-8000-0000000000f1",
  name: "Research",
  icon: "book",
  color: 3,
  bookmarkCount: 12,
  createdAt: "2026-09-10T08:00:00.000Z",
};

const MARKUP: TestFormerFolder = {
  id: "0192f3a0-eeee-7000-8000-0000000000f2",
  name: "<b>bold</b>",
  icon: "folder",
  color: 1,
  bookmarkCount: 0,
  createdAt: "2026-09-11T08:00:00.000Z",
};

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function openMembers(): Promise<void> {
  window.history.replaceState(null, "", "/settings/workspace/members");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

function server(options: WorkspaceSettingsServerOptions = {}) {
  return stubWorkspaceSettingsServer({ members: [SELF], ...options });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

// Base UI keeps a dialog that is closing in the document while it animates out, and it is still found by its role, so "found" does not mean "open":
// an open dialog is marked data-open and carries neither data-closed nor data-ending-style.
function expectConfirmationOpen(name = "Delete former members' content?"): void {
  const dialog = screen.getByRole("alertdialog", { name });
  expect(dialog.hasAttribute("data-open")).toBe(true);
  expect(dialog.hasAttribute("data-closed")).toBe(false);
  expect(dialog.hasAttribute("data-ending-style")).toBe(false);
}

function cellsOf(table: HTMLElement, text: string): string[] {
  const row = within(table)
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(text) !== null);
  if (row === undefined) {
    throw new Error(`no row for ${text}`);
  }
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

describe("the former members' content section", () => {
  it.each<Role>(["owner", "admin"])("lists the bookmarks and folders that have no owner to %s, each in a table of its own", async (role) => {
    const stub = server({ role, formerBookmarks: [SPEC, PLAIN], formerFolders: [RESEARCH] });
    await openMembers();

    const bookmarks = await screen.findByRole("table", { name: "Bookmarks" });
    const folders = await screen.findByRole("table", { name: "Folders" });
    expect(screen.getByRole("heading", { name: "Former members' content" })).toBeTruthy();
    expect(within(bookmarks).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["", "Title", "Host", "Slug", "Created"]);
    expect(cellsOf(bookmarks, "Protocol specification").slice(1, 4)).toEqual(["Protocol specification", "example.org", "spec"]);
    expect(cellsOf(bookmarks, "Protocol specification")[4]).toContain("2026");
    expect(cellsOf(bookmarks, "Reading list").slice(1, 4)).toEqual(["Reading list", "example.net", "No slug"]);
    expect(within(folders).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["", "Name", "Bookmarks", "Created"]);
    expect(cellsOf(folders, "Research").slice(1, 3)).toEqual(["Research", "12"]);
    expect(screen.queryByText("No content from former members")).toBeNull();
    expect(stub.received("GET", BOOKMARKS_PATH)).toHaveLength(1);
    expect(stub.received("GET", FOLDERS_PATH)).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("draws a title and a folder name as text, never as markup", async () => {
    server({ formerBookmarks: [HOSTILE], formerFolders: [MARKUP] });
    await openMembers();

    const bookmarks = await screen.findByRole("table", { name: "Bookmarks" });
    const folders = await screen.findByRole("table", { name: "Folders" });
    expect(within(bookmarks).getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(within(folders).getByText("<b>bold</b>")).toBeTruthy();
    expect(bookmarks.querySelector("img")).toBeNull();
    expect(folders.querySelector("b")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a table only for the list that has rows, and says nothing is empty only when both lists are", async () => {
    server({ formerFolders: [RESEARCH] });
    await openMembers();

    expect(await screen.findByRole("table", { name: "Folders" })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Bookmarks" })).toBeNull();
    expect(screen.queryByText("No content from former members")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says there is no content from former members instead of showing two empty tables", async () => {
    server();
    await openMembers();

    expect(await screen.findByText("No content from former members")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Bookmarks" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Folders" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a wait until the lists arrive, and no empty state meanwhile", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server({
      formerBookmarks: [SPEC],
      formerGet: async (list) => {
        await gate;
        return list === "bookmarks" ? json({ items: [SPEC], nextCursor: null }) : json({ items: [], nextCursor: null });
      },
    });
    await openMembers();

    expect(await screen.findByRole("status", { name: "Loading former members' content" })).toBeTruthy();
    expect(screen.queryByText("No content from former members")).toBeNull();
    await act(async () => {
      release();
      await gate;
    });
    expect(await screen.findByRole("table", { name: "Bookmarks" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading former members' content" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says a list could not be loaded instead of showing it as empty, keeps the other list, and loads it again on retry", async () => {
    server({
      formerFolders: [RESEARCH],
      formerGet: (list, call) =>
        list === "bookmarks" ? (call <= 3 ? problem(503, "unavailable", "req-503") : json({ items: [SPEC], nextCursor: null })) : undefined,
    });
    await openMembers();

    expect(await screen.findByText("The bookmarks of former members could not be loaded", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("No content from former members")).toBeNull();
    expect(screen.queryByRole("table", { name: "Bookmarks" })).toBeNull();
    expect(within(await screen.findByRole("table", { name: "Folders" })).getByText("Research")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("table", { name: "Bookmarks" })).toBeTruthy();
    expect(screen.queryByText("The bookmarks of former members could not be loaded")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says so when a request is rejected before it gets an answer, and not that nothing is there", async () => {
    server({
      formerGet: (list) => (list === "folders" ? Promise.reject(new TypeError("Failed to fetch")) : undefined),
    });
    await openMembers();

    expect(await screen.findByText("The folders of former members could not be loaded", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("No content from former members")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows more of a list from the cursor of the page before, and keeps the rows it has when the next page fails", async () => {
    let recovered = false;
    const stub = server({
      formerBookmarks: [SPEC, PLAIN],
      formerPageSize: 1,
      formerGet: (list, _call, request) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        return list === "bookmarks" && cursor !== null && !recovered ? problem(503, "unavailable", "req-503") : undefined;
      },
    });
    await openMembers();

    const table = await screen.findByRole("table", { name: "Bookmarks" });
    expect(within(table).queryByText("Reading list")).toBeNull();
    await press(screen.getByRole("button", { name: "Show more" }));

    expect(await screen.findByText("The bookmarks of former members could not be loaded", undefined, { timeout: 5000 })).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Bookmarks" })).getByText("Protocol specification")).toBeTruthy();
    expect(screen.queryByText("No content from former members")).toBeNull();
    recovered = true;
    await press(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(within(screen.getByRole("table", { name: "Bookmarks" })).getByText("Reading list")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(stub.received("GET", BOOKMARKS_PATH).length).toBeGreaterThanOrEqual(2);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a plain member the 403 page and asks for none of the content", async () => {
    const stub = server({ role: "member", formerBookmarks: [SPEC], formerFolders: [RESEARCH] });
    await openMembers();

    expect(await screen.findByRole("heading", { name: "You don't have access" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Former members' content" })).toBeNull();
    expect(stub.received("GET", BOOKMARKS_PATH)).toHaveLength(0);
    expect(stub.received("GET", FOLDERS_PATH)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("has no axe violations", async () => {
    server({ formerBookmarks: [SPEC, PLAIN], formerFolders: [RESEARCH] });
    await openMembers();
    await screen.findByRole("table", { name: "Folders" });

    const results = await axe(document.body, { rules: { region: { enabled: false } } });

    expect(results.violations.map(({ id }) => id)).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);
});

async function choose(name: string): Promise<void> {
  await press(await screen.findByRole("checkbox", { name }));
}

describe("deleting the former members' content", () => {
  it("offers Delete disabled while nothing is selected, and a checkbox for each row and one to select the loaded rows of a table", async () => {
    const stub = server({ formerBookmarks: [SPEC, PLAIN], formerFolders: [RESEARCH] });
    await openMembers();

    const remove = await screen.findByRole("button", { name: "Delete selected" });
    expect(remove.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    await choose("Select Protocol specification");
    expect(screen.getByRole("button", { name: "Delete selected" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("1 selected")).toBeTruthy();
    await choose("Select Protocol specification");
    expect(screen.getByRole("button", { name: "Delete selected" }).hasAttribute("disabled")).toBe(true);
    await choose("Select all loaded bookmarks");
    expect(screen.getByText("2 selected")).toBeTruthy();
    await choose("Select all loaded bookmarks");
    expect(screen.queryByText("2 selected")).toBeNull();
    expect(stub.received("POST", DELETE_PATH)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("states the counts in a confirmation, sends nothing before it is confirmed or when it is cancelled, and keeps the selection", async () => {
    const stub = server({ formerBookmarks: [SPEC, PLAIN], formerFolders: [RESEARCH] });
    await openMembers();
    await choose("Select Protocol specification");
    await choose("Select Research");

    await press(screen.getByRole("button", { name: "Delete selected" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Delete former members' content?" });
    expect(within(dialog).getByText(/Deleting 1 bookmark and 1 folder is permanent\./)).toBeTruthy();
    expect(within(dialog).getByText(/There is no trash and no undo\./)).toBeTruthy();
    expect(within(dialog).getByText(/Deleting a folder does not delete the bookmarks filed in it/)).toBeTruthy();
    expect(stub.received("POST", DELETE_PATH)).toHaveLength(0);
    await press(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(stub.received("POST", DELETE_PATH)).toHaveLength(0);
    expect(screen.getByText("2 selected")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("deletes the selected rows, says what was deleted, reads the lists again and clears the selection", async () => {
    const stub = server({ formerBookmarks: [SPEC, PLAIN], formerFolders: [RESEARCH, MARKUP] });
    await openMembers();
    await choose("Select Protocol specification");
    await choose("Select Research");
    await press(screen.getByRole("button", { name: "Delete selected" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete former members' content?" });

    await press(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("1 bookmark and 1 folder deleted.")).toBeTruthy();
    expect(stub.received("POST", DELETE_PATH).map((call) => call.body)).toEqual([{ bookmarkIds: [SPEC.id], folderIds: [RESEARCH.id] }]);
    await waitFor(() => {
      expect(within(screen.getByRole("table", { name: "Bookmarks" })).queryByText("Protocol specification")).toBeNull();
    });
    expect(within(screen.getByRole("table", { name: "Bookmarks" })).getByText("Reading list")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Folders" })).queryByText("Research")).toBeNull();
    expect(within(screen.getByRole("table", { name: "Folders" })).getByText("<b>bold</b>")).toBeTruthy();
    expect(stub.received("GET", BOOKMARKS_PATH).length).toBeGreaterThanOrEqual(2);
    expect(stub.received("GET", FOLDERS_PATH).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete selected" }).hasAttribute("disabled")).toBe(true);
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the confirmation open, with its wait, until the lists have been read again, and only then closes it, says what was deleted and clears the selection", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = server({
      formerBookmarks: [SPEC, PLAIN],
      // The first read of the bookmarks is the section's own; the second is the one the deletion asks for, and it waits here.
      formerGet: (list, call) => (list === "bookmarks" && call === 2 ? held.then(() => json({ items: [PLAIN], nextCursor: null })) : undefined),
    });
    await openMembers();
    await choose("Select Protocol specification");
    await press(screen.getByRole("button", { name: "Delete selected" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete former members' content?" });

    await press(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(stub.received("GET", BOOKMARKS_PATH)).toHaveLength(2);
    });

    expect(stub.received("POST", DELETE_PATH)).toHaveLength(1);
    expectConfirmationOpen();
    expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: /Loading/ }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByText("1 bookmark deleted.")).toBeNull();
    expect(screen.getByText("1 selected")).toBeTruthy();
    // The dialog is modal, so the table behind it is hidden from the accessibility tree: the row is found by its text.
    expect(screen.getByText("Protocol specification")).toBeTruthy();

    release();

    expect(await screen.findByText("1 bookmark deleted.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(within(screen.getByRole("table", { name: "Bookmarks" })).queryByText("Protocol specification")).toBeNull();
    expect(screen.queryByText("1 selected")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the confirmation open until the lists have been read again after a failed request too, and then closes it with the selection kept", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = server({
      formerBookmarks: [SPEC, PLAIN],
      formerGet: (list, call) => (list === "bookmarks" && call === 2 ? held.then(() => json({ items: [SPEC, PLAIN], nextCursor: null })) : undefined),
      formerDelete: () => problem(503, "unavailable", "req-503"),
    });
    await openMembers();
    await choose("Select Protocol specification");
    await press(screen.getByRole("button", { name: "Delete selected" }));
    await press(within(await screen.findByRole("alertdialog", { name: "Delete former members' content?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(stub.received("GET", BOOKMARKS_PATH)).toHaveLength(2);
    });

    expectConfirmationOpen();

    release();

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Bookmarks" })).getByText("Protocol specification")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("sends a list that holds nothing selected as absent, so a bookmarks-only deletion names no folders", async () => {
    const stub = server({ formerBookmarks: [SPEC, PLAIN] });
    await openMembers();
    await choose("Select all loaded bookmarks");
    await press(screen.getByRole("button", { name: "Delete selected" }));
    await press(within(await screen.findByRole("alertdialog", { name: "Delete former members' content?" })).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("2 bookmarks deleted.")).toBeTruthy();
    expect(stub.received("POST", DELETE_PATH).map((call) => call.body)).toEqual([{ bookmarkIds: [SPEC.id, PLAIN.id] }]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the empty state of the section when the deletion leaves nothing", async () => {
    server({ formerBookmarks: [SPEC], formerFolders: [RESEARCH] });
    await openMembers();
    await choose("Select Protocol specification");
    await choose("Select Research");
    await press(screen.getByRole("button", { name: "Delete selected" }));
    await press(within(await screen.findByRole("alertdialog", { name: "Delete former members' content?" })).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("No content from former members")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Bookmarks" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Folders" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete selected" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("never draws a failed request as done: it shows the error toast, keeps the rows and the selection, and reads the lists again", async () => {
    const stub = server({ formerBookmarks: [SPEC, PLAIN], formerFolders: [RESEARCH], formerDelete: () => problem(503, "unavailable", "req-503") });
    await openMembers();
    await choose("Select Protocol specification");
    await press(screen.getByRole("button", { name: "Delete selected" }));
    await press(within(await screen.findByRole("alertdialog", { name: "Delete former members' content?" })).getByRole("button", { name: "Delete" }));

    expect((await screen.findAllByText("req-503", { exact: false })).length).toBeGreaterThan(0);
    expect(screen.queryByText(/deleted\./)).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(within(screen.getByRole("table", { name: "Bookmarks" })).getByText("Protocol specification")).toBeTruthy();
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete selected" }).hasAttribute("disabled")).toBe(false);
    await waitFor(() => {
      expect(stub.received("GET", BOOKMARKS_PATH).length).toBeGreaterThanOrEqual(2);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("treats a request that is rejected before it gets an answer as a failure too, and keeps the selection", async () => {
    server({ formerBookmarks: [SPEC], formerDelete: () => Promise.reject(new TypeError("Failed to fetch")) });
    await openMembers();
    await choose("Select Protocol specification");
    await press(screen.getByRole("button", { name: "Delete selected" }));
    await press(within(await screen.findByRole("alertdialog", { name: "Delete former members' content?" })).getByRole("button", { name: "Delete" }));

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/deleted\./)).toBeNull();
    expect(within(screen.getByRole("table", { name: "Bookmarks" })).getByText("Protocol specification")).toBeTruthy();
    expect(screen.getByText("1 selected")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says nothing was deleted when the server found none of the rows, and clears the selection", async () => {
    server({ formerBookmarks: [SPEC], formerDelete: () => json({ bookmarksDeleted: 0, foldersDeleted: 0 }) });
    await openMembers();
    await choose("Select Protocol specification");
    await press(screen.getByRole("button", { name: "Delete selected" }));
    await press(within(await screen.findByRole("alertdialog", { name: "Delete former members' content?" })).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Nothing was deleted. The content was already gone, or it has an owner again.")).toBeTruthy();
    expect(screen.queryByText("1 selected")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("has no axe violations with a selection and the confirmation open", async () => {
    server({ formerBookmarks: [SPEC, PLAIN], formerFolders: [RESEARCH] });
    await openMembers();
    await choose("Select Protocol specification");
    await press(screen.getByRole("button", { name: "Delete selected" }));
    await screen.findByRole("alertdialog", { name: "Delete former members' content?" });

    const results = await axe(document.body, { rules: { region: { enabled: false } } });

    expect(results.violations.map(({ id }) => id)).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("deleteFormerContent", () => {
  const ids = (count: number, prefix: string): string[] => Array.from({ length: count }, (_, index) => `${prefix}-${String(index)}`);

  function fakeApi(answer: (call: number, body: { bookmarkIds?: string[]; folderIds?: string[] }) => { data?: { bookmarksDeleted: number; foldersDeleted: number } | undefined; throws?: Error }) {
    const bodies: { bookmarkIds?: string[]; folderIds?: string[] }[] = [];
    const POST = vi.fn((_path: string, init: { body: { bookmarkIds?: string[]; folderIds?: string[] } }) => {
      bodies.push(init.body);
      const result = answer(bodies.length, init.body);
      return result.throws === undefined ? Promise.resolve({ data: result.data, error: undefined }) : Promise.reject(result.throws);
    });
    return { api: { POST } as unknown as ApiClient, bodies };
  }

  it("splits a selection of more than 1 000 of a list into requests of at most 1 000 and adds the answers up", async () => {
    const { api, bodies } = fakeApi((_call, body) => ({ data: { bookmarksDeleted: body.bookmarkIds?.length ?? 0, foldersDeleted: body.folderIds?.length ?? 0 } }));

    const deleted = await deleteFormerContent(api, { bookmarkIds: ids(2300, "b"), folderIds: ids(5, "f") });

    expect(deleted).toEqual({ bookmarksDeleted: 2300, foldersDeleted: 5 });
    expect(bodies.map((body) => [body.bookmarkIds?.length, body.folderIds?.length])).toEqual([
      [1000, 5],
      [1000, undefined],
      [300, undefined],
    ]);
  });

  it("reports the progress of the requests that answered, and throws the failure of the one that did not", async () => {
    const failure = new Error("unavailable");
    const { api } = fakeApi((call, body) => (call === 2 ? { throws: failure } : { data: { bookmarksDeleted: body.bookmarkIds?.length ?? 0, foldersDeleted: 0 } }));
    const progress: unknown[] = [];

    await expect(deleteFormerContent(api, { bookmarkIds: ids(1500, "b"), folderIds: [] }, (deleted) => progress.push(deleted))).rejects.toBe(failure);

    expect(progress).toEqual([{ bookmarksDeleted: 1000, foldersDeleted: 0 }]);
  });

  it("sends no request for an empty selection", async () => {
    const { api, bodies } = fakeApi(() => ({ data: { bookmarksDeleted: 0, foldersDeleted: 0 } }));

    expect(await deleteFormerContent(api, { bookmarkIds: [], folderIds: [] })).toEqual({ bookmarksDeleted: 0, foldersDeleted: 0 });
    expect(bodies).toEqual([]);
  });
});

const REASSIGN_TITLE = "Reassign former members' content?";

async function openRecipientPicker(dialog: HTMLElement): Promise<void> {
  const input = within(dialog).getByRole("combobox", { name: "New owner" });
  await act(async () => {
    // Base UI opens the list on a press that began on the input.
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
}

/** Selects the rows, presses Reassign to…, picks the member and presses Continue; the confirmation is open when it returns. */
async function reachConfirmation(recipient: string, selection: readonly string[] = ["Select Protocol specification"]): Promise<HTMLElement> {
  for (const name of selection) {
    await choose(name);
  }
  await press(screen.getByRole("button", { name: "Reassign to…" }));
  const dialog = await screen.findByRole("dialog", { name: "Reassign former members' content" });
  await openRecipientPicker(dialog);
  await press(await screen.findByRole("option", { name: new RegExp(recipient) }));
  await press(within(dialog).getByRole("button", { name: "Continue" }));
  return screen.findByRole("alertdialog", { name: REASSIGN_TITLE });
}

describe("reassigning the former members' content", () => {
  it("offers Reassign to… disabled while nothing is selected, and enabled with a selection", async () => {
    const stub = server({ members: [SELF, GRACE], formerBookmarks: [SPEC, PLAIN], formerFolders: [RESEARCH] });
    await openMembers();

    expect((await screen.findByRole("button", { name: "Reassign to…" })).hasAttribute("disabled")).toBe(true);
    await choose("Select Research");
    expect(screen.getByRole("button", { name: "Reassign to…" }).hasAttribute("disabled")).toBe(false);
    await choose("Select Research");
    expect(screen.getByRole("button", { name: "Reassign to…" }).hasAttribute("disabled")).toBe(true);
    expect(stub.received("POST", REASSIGN_PATH)).toHaveLength(0);
  }, SLOW_TEST_TIMEOUT_MS);

  it("lists the current members of the workspace in the picker, and none before one is chosen continues", async () => {
    server({ members: [SELF, GRACE], formerBookmarks: [SPEC] });
    await openMembers();
    await choose("Select Protocol specification");
    await press(screen.getByRole("button", { name: "Reassign to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reassign former members' content" });
    expect(within(dialog).getByText("Choose the member who becomes the owner of 1 bookmark.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);

    await openRecipientPicker(dialog);

    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Ada Lovelaceada@example.org", "Grace Hoppergrace@example.org"]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("states what the move does in a confirmation, sends nothing before it is confirmed or when it is cancelled, and keeps the selection", async () => {
    const stub = server({ members: [SELF, GRACE], formerBookmarks: [SPEC, PLAIN], formerFolders: [RESEARCH] });
    await openMembers();

    const confirmation = await reachConfirmation("Grace Hopper", ["Select Protocol specification", "Select Research"]);

    expect(
      within(confirmation).getByText(/Grace Hopper becomes the owner of 1 bookmark and 1 folder\. A bookmark whose slug Grace Hopper already uses loses its slug and stops forwarding\./),
    ).toBeTruthy();
    expect(within(confirmation).getByText(/A folder whose name Grace Hopper already has gets a number added/)).toBeTruthy();
    expect(within(confirmation).getByText(/A filing that would link a folder and a bookmark with different owners is removed\. Shares stay in force\./)).toBeTruthy();
    expect(stub.received("POST", REASSIGN_PATH)).toHaveLength(0);
    await press(within(confirmation).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(stub.received("POST", REASSIGN_PATH)).toHaveLength(0);
    expect(screen.getByText("2 selected")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("reassigns the selected rows to the member, says what was moved and what the move changed on the way, reads the lists again and clears the selection", async () => {
    const stub = server({
      members: [SELF, GRACE],
      formerBookmarks: [SPEC, PLAIN],
      formerFolders: [RESEARCH, MARKUP],
      formerReassign: () => json({ bookmarksMoved: 1, foldersMoved: 1, slugsCleared: 1, foldersRenamed: 1, filingsRemoved: 3 }),
    });
    await openMembers();

    const confirmation = await reachConfirmation("Grace Hopper", ["Select Protocol specification", "Select Research"]);
    await press(within(confirmation).getByRole("button", { name: "Reassign" }));

    expect(await screen.findByText("1 bookmark and 1 folder reassigned to Grace Hopper.")).toBeTruthy();
    expect(
      screen.getByText(
        "1 slug was removed because the member already uses it. 1 folder was renamed because the member has a folder with that name. 3 filings were removed because their folders and bookmarks have different owners.",
      ),
    ).toBeTruthy();
    expect(stub.received("POST", REASSIGN_PATH).map((call) => call.body)).toEqual([{ bookmarkIds: [SPEC.id], folderIds: [RESEARCH.id], transferTo: GRACE.accountId }]);
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(stub.received("GET", BOOKMARKS_PATH).length).toBeGreaterThanOrEqual(2);
    expect(stub.received("GET", FOLDERS_PATH).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("2 selected")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("reads the member's own folders again after a reassignment, so folders moved to oneself appear in the sidebar", async () => {
    const stub = server({
      members: [SELF, GRACE],
      formerFolders: [RESEARCH],
      formerReassign: () => json({ bookmarksMoved: 0, foldersMoved: 1, slugsCleared: 0, foldersRenamed: 0, filingsRemoved: 0 }),
      // The sidebar's list of the member's own folders.
      other: (request) => Promise.resolve(new URL(request.url).pathname === "/api/v1/folders" ? json({ items: [], nextCursor: null }) : problem(404, "not_found", "req-404")),
    });
    await openMembers();

    const confirmation = await reachConfirmation("Ada Lovelace", ["Select Research"]);
    const sidebarReadsBefore = stub.received("GET", "/api/v1/folders").length;
    await press(within(confirmation).getByRole("button", { name: "Reassign" }));

    expect(await screen.findByText("1 folder reassigned to Ada Lovelace.")).toBeTruthy();
    expect(stub.received("GET", "/api/v1/folders").length).toBeGreaterThan(sidebarReadsBefore);
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the confirmation open, with its wait, until the lists have been read again, and only then closes it, says what was moved and clears the selection", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = server({
      members: [SELF, GRACE],
      formerBookmarks: [SPEC, PLAIN],
      // The first read of the bookmarks is the section's own; the second is the one the reassignment asks for, and it waits here.
      formerGet: (list, call) => (list === "bookmarks" && call === 2 ? held.then(() => json({ items: [PLAIN], nextCursor: null })) : undefined),
    });
    await openMembers();
    await reachConfirmation("Grace Hopper");

    await press(within(screen.getByRole("alertdialog", { name: REASSIGN_TITLE })).getByRole("button", { name: "Reassign" }));
    await waitFor(() => {
      expect(stub.received("GET", BOOKMARKS_PATH)).toHaveLength(2);
    });

    expect(stub.received("POST", REASSIGN_PATH)).toHaveLength(1);
    expectConfirmationOpen(REASSIGN_TITLE);
    expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: /Loading/ }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByText("1 bookmark reassigned to Grace Hopper.")).toBeNull();
    expect(screen.getByText("1 selected")).toBeTruthy();

    release();

    expect(await screen.findByText("1 bookmark reassigned to Grace Hopper.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(within(screen.getByRole("table", { name: "Bookmarks" })).queryByText("Protocol specification")).toBeNull();
    expect(screen.queryByText("1 selected")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the confirmation open until the lists have been read again after a failed request too, then closes it, reports the failure and keeps the selection", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = server({
      members: [SELF, GRACE],
      formerBookmarks: [SPEC, PLAIN],
      formerGet: (list, call) => (list === "bookmarks" && call === 2 ? held.then(() => json({ items: [SPEC, PLAIN], nextCursor: null })) : undefined),
      formerReassign: () => problem(503, "unavailable", "req-503"),
    });
    await openMembers();
    await reachConfirmation("Grace Hopper");
    await press(within(screen.getByRole("alertdialog", { name: REASSIGN_TITLE })).getByRole("button", { name: "Reassign" }));
    await waitFor(() => {
      expect(stub.received("GET", BOOKMARKS_PATH)).toHaveLength(2);
    });

    expectConfirmationOpen(REASSIGN_TITLE);

    release();

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect((await screen.findAllByText("req-503", { exact: false })).length).toBeGreaterThan(0);
    expect(screen.queryByText(/reassigned to/)).toBeNull();
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Bookmarks" })).getByText("Protocol specification")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("names the recipient in the picker when the server says they are no member any more, keeps the selection and sends nothing more until another member is chosen", async () => {
    const stub = server({
      members: [SELF, GRACE],
      formerBookmarks: [SPEC, PLAIN],
      formerReassign: (call) =>
        call === 1
          ? json(
              { type: "x", title: "x", status: 404, code: "not_found", detail: "x", requestId: "req-404", errors: [{ path: "transferTo", code: "not_found" }] },
              { status: 404, contentType: "application/problem+json" },
            )
          : undefined,
    });
    await openMembers();
    await reachConfirmation("Grace Hopper");

    await press(within(screen.getByRole("alertdialog", { name: REASSIGN_TITLE })).getByRole("button", { name: "Reassign" }));

    const dialog = await screen.findByRole("dialog", { name: "Reassign former members' content" });
    expect(await within(dialog).findByText("Grace Hopper is no longer a member of this workspace. Choose another member; your selection is kept.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    expect(stub.received("POST", REASSIGN_PATH)).toHaveLength(1);
    expect(screen.queryByText(/reassigned to/)).toBeNull();
    // Choosing another member clears the message and the move can be confirmed again; the selection was never lost.
    await openRecipientPicker(dialog);
    await press(await screen.findByRole("option", { name: /Ada Lovelace/ }));
    expect(within(dialog).queryByText(/is no longer a member of this workspace/)).toBeNull();
    await press(within(dialog).getByRole("button", { name: "Continue" }));
    await press(within(await screen.findByRole("alertdialog", { name: REASSIGN_TITLE })).getByRole("button", { name: "Reassign" }));

    expect(await screen.findByText("1 bookmark reassigned to Ada Lovelace.")).toBeTruthy();
    expect(stub.received("POST", REASSIGN_PATH).map((call) => call.body)).toEqual([
      { bookmarkIds: [SPEC.id], transferTo: GRACE.accountId },
      { bookmarkIds: [SPEC.id], transferTo: SELF.accountId },
    ]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("treats a request that is rejected before it gets an answer as a failure too, and keeps the selection", async () => {
    server({
      members: [SELF, GRACE],
      formerBookmarks: [SPEC],
      formerReassign: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await openMembers();
    await reachConfirmation("Grace Hopper");
    await press(within(screen.getByRole("alertdialog", { name: REASSIGN_TITLE })).getByRole("button", { name: "Reassign" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(screen.queryByText(/reassigned to/)).toBeNull();
    expect(screen.getByText("1 selected")).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("says nothing was reassigned when the server found none of the rows, and clears the selection", async () => {
    server({ members: [SELF, GRACE], formerBookmarks: [SPEC], formerReassign: () => json({ bookmarksMoved: 0, foldersMoved: 0, slugsCleared: 0, foldersRenamed: 0, filingsRemoved: 0 }) });
    await openMembers();
    await reachConfirmation("Grace Hopper");

    await press(within(screen.getByRole("alertdialog", { name: REASSIGN_TITLE })).getByRole("button", { name: "Reassign" }));

    expect(await screen.findByText("Nothing was reassigned. The content was already gone, or it has an owner again.")).toBeTruthy();
    expect(screen.queryByText("1 selected")).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("refuses a selection of more than 1 000 bookmarks before any request: the action is off and a message says the limit and how to reassign", async () => {
    const many: TestFormerBookmark[] = Array.from({ length: 1001 }, (_, index) => ({ ...PLAIN, id: `0192f3a0-aaaa-7000-8000-${String(index).padStart(12, "0")}`, title: `Bookmark ${String(index)}` }));
    const stub = server({ members: [SELF, GRACE], formerBookmarks: many, formerFolders: [RESEARCH] });
    await openMembers();

    await choose("Select Research");
    expect(screen.getByRole("button", { name: "Reassign to…" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(/One reassignment takes at most/)).toBeNull();
    await choose("Select all loaded bookmarks");

    expect(screen.getByText("1,002 selected")).toBeTruthy();
    expect(
      screen.getByText(
        "One reassignment takes at most 1,000 bookmarks and 1,000 folders. Reassign in smaller selections, and select each folder together with its bookmarks so that they stay filed together.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reassign to…" }).hasAttribute("disabled")).toBe(true);
    await press(screen.getByRole("button", { name: "Reassign to…" }));
    expect(screen.queryByRole("dialog", { name: "Reassign former members' content" })).toBeNull();
    expect(stub.received("POST", REASSIGN_PATH)).toHaveLength(0);
    // The deletion has no such limit on the screen: it splits its own requests.
    expect(screen.getByRole("button", { name: "Delete selected" }).hasAttribute("disabled")).toBe(false);
  }, SLOW_TEST_TIMEOUT_MS);

  it("has no axe violations with the picker dialog and with the confirmation open", async () => {
    server({ members: [SELF, GRACE], formerBookmarks: [SPEC], formerFolders: [RESEARCH] });
    await openMembers();
    await choose("Select Protocol specification");
    await press(screen.getByRole("button", { name: "Reassign to…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reassign former members' content" });
    await within(dialog).findByRole("combobox", { name: "New owner" });
    expect((await axe(document.body, { rules: { region: { enabled: false } } })).violations.map(({ id }) => id)).toEqual([]);
    await openRecipientPicker(dialog);
    await press(await screen.findByRole("option", { name: /Grace Hopper/ }));
    await press(within(dialog).getByRole("button", { name: "Continue" }));
    await screen.findByRole("alertdialog", { name: REASSIGN_TITLE });

    expect((await axe(document.body, { rules: { region: { enabled: false } } })).violations.map(({ id }) => id)).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("reassignFormerContent", () => {
  const ids = (count: number, prefix: string): string[] => Array.from({ length: count }, (_, index) => `${prefix}-${String(index)}`);
  const RECIPIENT = "0192f3a0-bbbb-7000-8000-000000000002";

  type Body = { bookmarkIds?: string[]; folderIds?: string[]; transferTo: string };
  type Answer = { moved?: { bookmarksMoved: number; foldersMoved: number; slugsCleared: number; foldersRenamed: number; filingsRemoved: number }; throws?: Error };

  function fakeApi(answer: (call: number, body: Body) => Answer) {
    const bodies: Body[] = [];
    const POST = vi.fn((_path: string, init: { body: Body }) => {
      bodies.push(init.body);
      const result = answer(bodies.length, init.body);
      return result.throws === undefined ? Promise.resolve({ data: result.moved, error: undefined }) : Promise.reject(result.throws);
    });
    return { api: { POST } as unknown as ApiClient, bodies };
  }

  const countsOf = (body: Body) => ({ bookmarksMoved: body.bookmarkIds?.length ?? 0, foldersMoved: body.folderIds?.length ?? 0, slugsCleared: 1, foldersRenamed: 0, filingsRemoved: 2 });

  it("sends a selection of exactly 1 000 of each list as one request that holds every folder and every bookmark, and answers what the server counted", async () => {
    const { api, bodies } = fakeApi((_call, body) => ({ moved: countsOf(body) }));
    const bookmarkIds = ids(1000, "b");
    const folderIds = ids(1000, "f");

    const outcome = await reassignFormerContent(api, { bookmarkIds, folderIds, transferTo: RECIPIENT });

    expect(outcome).toEqual({ status: "reassigned", reassigned: { bookmarksMoved: 1000, foldersMoved: 1000, slugsCleared: 1, foldersRenamed: 0, filingsRemoved: 2 } });
    expect(bodies).toEqual([{ bookmarkIds, folderIds, transferTo: RECIPIENT }]);
  });

  it.each([
    ["bookmarks", 1001, 5],
    ["folders", 5, 1001],
  ])("refuses a selection of more than 1 000 %s without sending a request", async (_list, bookmarks, folders) => {
    const { api, bodies } = fakeApi((_call, body) => ({ moved: countsOf(body) }));

    await expect(reassignFormerContent(api, { bookmarkIds: ids(bookmarks, "b"), folderIds: ids(folders, "f"), transferTo: RECIPIENT })).rejects.toBeInstanceOf(RangeError);

    expect(bodies).toEqual([]);
  });

  it("throws the failure of the request", async () => {
    const failure = new Error("unavailable");
    const { api, bodies } = fakeApi(() => ({ throws: failure }));

    await expect(reassignFormerContent(api, { bookmarkIds: ids(3, "b"), folderIds: [], transferTo: RECIPIENT })).rejects.toBe(failure);

    expect(bodies).toHaveLength(1);
  });

  it("answers recipientGone for a 404 naming transferTo", async () => {
    const gone = new ApiProblemError({ code: "not_found", status: 404, requestId: "req-404", errors: [{ path: "transferTo", code: "not_found" }] });
    const { api, bodies } = fakeApi(() => ({ throws: gone }));

    expect(await reassignFormerContent(api, { bookmarkIds: ids(5, "b"), folderIds: [], transferTo: RECIPIENT })).toEqual({ status: "recipientGone" });
    expect(bodies).toHaveLength(1);
  });

  it("throws a 404 that does not name transferTo, like any other failure", async () => {
    const missing = new ApiProblemError({ code: "not_found", status: 404, requestId: "req-404" });
    const { api } = fakeApi(() => ({ throws: missing }));

    await expect(reassignFormerContent(api, { bookmarkIds: ids(1, "b"), folderIds: [], transferTo: RECIPIENT })).rejects.toBe(missing);
  });

  it("sends no request for an empty selection", async () => {
    const { api, bodies } = fakeApi((_call, body) => ({ moved: countsOf(body) }));

    expect(await reassignFormerContent(api, { bookmarkIds: [], folderIds: [], transferTo: RECIPIENT })).toEqual({
      status: "reassigned",
      reassigned: { bookmarksMoved: 0, foldersMoved: 0, slugsCleared: 0, foldersRenamed: 0, filingsRemoved: 0 },
    });
    expect(bodies).toEqual([]);
  });
});
