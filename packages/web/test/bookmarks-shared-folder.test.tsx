import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The folder filter of the bookmarks list with a folder that another member shared with the member (doc 03 section 6 and the sidebar
// Folders section, doc 04 section 10.6). The failure scenarios are a folder shared with the member called gone and taken off the address
// (so a click in the sidebar lands on the whole list), a shared folder offered as a place to file into, and a folder that really is gone
// no longer cleared. The transport is stubbed and answers the folder lists by scope, as the API does.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Folder = ComponentTypes["schemas"]["Folder"];
type Transport = (request: Request) => Promise<Response>;

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const GRACE = "0192f3a0-bbbb-7000-8000-000000000002";
const WORK = "0192f3a0-dddd-7000-8000-000000000001";
const SHARED = "0192f3a0-dddd-7000-8000-000000000002";
const GONE = "0192f3a0-dddd-7000-8000-000000000099";
const STAMP = "2026-10-01T08:00:00.000Z";

function folder(id: string, name: string, overrides: Partial<Folder> = {}): Folder {
  return { id, ownerId: OWNER, name, icon: "folder", color: 1, bookmarkCount: 1, version: 1, createdAt: STAMP, updatedAt: STAMP, ...overrides };
}

const MINE = [folder(WORK, "Work")];
const SHARED_WITH_ME = [folder(SHARED, "Grace's reading", { ownerId: GRACE, owner: { accountId: GRACE, displayName: "Grace Hopper" }, shareSummary: null })];

function bookmark(n: number, title: string, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`,
    ownerId: OWNER,
    url: `https://site${String(n)}.example.com/page`,
    host: `site${String(n)}.example.com`,
    title,
    description: null,
    slug: null,
    forwarding: false,
    pinned: false,
    openCount: 0,
    lastOpenedAt: null,
    folders: [],
    tags: [],
    version: 3,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

const IN_WORK = bookmark(1, "Own work page");
const IN_SHARED = bookmark(2, "Grace's article", { ownerId: GRACE, owner: { accountId: GRACE, displayName: "Grace Hopper" }, sharedVia: "folder" });

interface Server {
  readonly lists: () => URLSearchParams[];
}

function stubServer(): Server {
  const lists: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) =>
      signedIn(request, (other) => {
        const url = new URL(other.url);
        if (url.pathname === "/api/v1/entitlements") {
          return Promise.resolve(
            json({
              entitlements: { "bookmarks.max": "unlimited", "seats.max": "unlimited", "workspaces.ownMax": "unlimited", "ai.suggestions": true, "sharing.members": true, "sharing.teams": true, "members.invite": true, "teams.manage": true, "audit.log": true },
              usage: { "bookmarks.used": 1, "seats.used": 1, "workspaces.owned": 1 },
              upgradeAvailable: false,
            }),
          );
        }
        if (url.pathname === "/api/v1/bookmarks" && other.method === "GET") {
          lists.push(url.searchParams);
          const folderId = url.searchParams.get("folderId");
          const items = folderId === SHARED ? [IN_SHARED] : folderId === WORK ? [IN_WORK] : folderId === null ? [IN_WORK, IN_SHARED] : [];
          return Promise.resolve(json({ items, nextCursor: null, total: items.length }));
        }
        if (url.pathname === "/api/v1/folders" && other.method === "GET") {
          const items = url.searchParams.get("scope") === "shared" ? SHARED_WITH_ME : MINE;
          return Promise.resolve(json({ items, nextCursor: null, total: items.length }));
        }
        if (url.pathname === "/api/v1/tags" && other.method === "GET") {
          return Promise.resolve(json({ items: [], nextCursor: null, total: 0 }));
        }
        return Promise.resolve(problem(404, "not_found", "req-404"));
      }),
    ),
  );
  return { lists: () => lists };
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

describe("a folder shared with the member in the bookmarks list", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("keeps the filter of a shared folder, names it in the folder field and lists the bookmarks filed in it", async () => {
    const server = stubServer();
    await openApp(`/bookmarks?folderId=${SHARED}`);

    await screen.findByRole("link", { name: "Grace's article" });
    expect(screen.queryByText("Own work page")).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Folder" }).value).toBe("Grace's reading");
    });
    expect(screen.queryByText("That folder no longer exists")).toBeNull();
    expect(window.location.search).toBe(`?folderId=${SHARED}`);
    expect(server.lists().at(-1)?.get("folderId")).toBe(SHARED);
  });

  it("lands on that folder's bookmarks from the shared folder of the sidebar, and marks it as the current one", async () => {
    const server = stubServer();
    await openApp("/bookmarks");
    const section = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-slot='sidebar-folders']");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });

    await press(await within(section).findByRole("link", { name: "Grace's reading" }));

    await screen.findByRole("link", { name: "Grace's article" });
    expect(screen.queryByText("Own work page")).toBeNull();
    expect(window.location.search).toBe(`?folderId=${SHARED}`);
    expect(screen.queryByText("That folder no longer exists")).toBeNull();
    expect(within(section).getByRole("link", { name: "Grace's reading" }).getAttribute("data-active")).toBe("true");
    expect(server.lists().at(-1)?.get("folderId")).toBe(SHARED);
  });

  it("still takes a folder that is neither the member's nor shared with them off the address, with the notice", async () => {
    const server = stubServer();
    await openApp(`/bookmarks?folderId=${GONE}&pinned=true`);

    expect((await screen.findByText("That folder no longer exists")).closest("[role='status']")).not.toBeNull();
    await waitFor(() => {
      expect(window.location.search).toBe("?pinned=true");
    });
    await waitFor(() => {
      expect(server.lists().at(-1)?.get("folderId")).toBeNull();
    });
  });

  it("offers the shared folder as a filter, and never as a place to file a bookmark into", async () => {
    stubServer();
    await openApp("/?new=1");
    const dialog = await screen.findByRole("dialog", { name: "New bookmark" });
    const input = await within(dialog).findByLabelText("Folders");
    await act(async () => {
      fireEvent.pointerDown(input);
      fireEvent.mouseDown(input);
      fireEvent.click(input);
      await Promise.resolve();
    });

    expect(await screen.findByRole("option", { name: "Work", hidden: true })).toBeDefined();
    expect(screen.queryByRole("option", { name: "Grace's reading", hidden: true })).toBeNull();
  });
});
