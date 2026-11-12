import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";
import { FORMER_CONTENT_PATH, SELF, stubWorkspaceSettingsServer, type Role, type TestFormerBookmark, type TestFormerFolder, type WorkspaceSettingsServerOptions } from "./workspace-settings-server.ts";

// The former members' content of /settings/workspace/members (doc 03 section 11.7, doc 02 section 2.10). The failure scenarios are a plain member whose
// page asks for content only admins may read, a list that failed to load shown as the empty state, a failed next page that drops the rows already
// shown, a title or a folder name that is drawn as markup, and an empty workspace that shows two empty tables.

const SLOW_TEST_TIMEOUT_MS = 30_000;
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
    expect(within(bookmarks).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Title", "Host", "Slug", "Created"]);
    expect(cellsOf(bookmarks, "Protocol specification").slice(0, 3)).toEqual(["Protocol specification", "example.org", "spec"]);
    expect(cellsOf(bookmarks, "Protocol specification")[3]).toContain("2026");
    expect(cellsOf(bookmarks, "Reading list").slice(0, 3)).toEqual(["Reading list", "example.net", "No slug"]);
    expect(within(folders).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Name", "Bookmarks", "Created"]);
    expect(cellsOf(folders, "Research").slice(0, 2)).toEqual(["Research", "12"]);
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

  it("offers no action on a row: the tables carry no selection, menu or button besides Show more", async () => {
    server({ formerBookmarks: [SPEC], formerFolders: [RESEARCH] });
    await openMembers();

    const bookmarks = await screen.findByRole("table", { name: "Bookmarks" });
    const folders = await screen.findByRole("table", { name: "Folders" });
    expect(within(bookmarks).queryAllByRole("button")).toEqual([]);
    expect(within(folders).queryAllByRole("button")).toEqual([]);
    expect(within(bookmarks).queryAllByRole("checkbox")).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("has no axe violations", async () => {
    server({ formerBookmarks: [SPEC, PLAIN], formerFolders: [RESEARCH] });
    await openMembers();
    await screen.findByRole("table", { name: "Folders" });

    const results = await axe(document.body, { rules: { region: { enabled: false } } });

    expect(results.violations.map(({ id }) => id)).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);
});
