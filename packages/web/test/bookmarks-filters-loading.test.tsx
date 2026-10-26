import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// What the folder and tag filters and the sidebar show while their lists are still on the way, which the generated
// handlers cannot hold back. The failure scenarios are a list that is being read shown as empty ("You have no folders"),
// and a folder of the address called deleted before the folder list has said which folders there are. The transport is
// stubbed.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Transport = (request: Request) => Promise<Response>;

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const WORK = "0192f3a0-dddd-7000-8000-000000000001";
const GONE = "0192f3a0-dddd-7000-8000-000000000099";

const BOOKMARK: Bookmark = {
  id: "0192f3a0-aaaa-7000-8000-000000000001",
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

function gate(): { readonly open: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open, release };
}

interface Server {
  readonly foldersGate: ReturnType<typeof gate>;
  readonly tagsGate: ReturnType<typeof gate>;
  readonly lists: () => URLSearchParams[];
}

/** A signed-in server whose folder and tag lists answer when the test lets them. */
function stubServer(): Server {
  const foldersGate = gate();
  const tagsGate = gate();
  const lists: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) =>
      signedIn(request, async (other) => {
        const url = new URL(other.url);
        if (url.pathname === "/api/v1/bookmarks" && other.method === "GET") {
          lists.push(url.searchParams);
          return json({ items: [BOOKMARK], nextCursor: null, total: 1 });
        }
        if (url.pathname === "/api/v1/folders" && other.method === "GET") {
          await foldersGate.open;
          return json({
            items: [{ id: WORK, ownerId: OWNER, name: "Work", icon: "folder", color: 1, bookmarkCount: 0, version: 1, createdAt: BOOKMARK.createdAt, updatedAt: BOOKMARK.createdAt }],
            nextCursor: null,
            total: 1,
          });
        }
        if (url.pathname === "/api/v1/tags" && other.method === "GET") {
          await tagsGate.open;
          return json({ items: [], nextCursor: null, total: 0 });
        }
        return problem(404, "not_found", "req-404");
      }),
    ),
  );
  return { foldersGate, tagsGate, lists: () => lists };
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

async function openField(name: string): Promise<void> {
  const input = await screen.findByRole("combobox", { name });
  await act(async () => {
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
}

describe("the lists behind the folder and tag filters while they are read", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("say they are loading, in the sidebar and in both fields, and then show what was read", async () => {
    const server = stubServer();
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Example docs" });
    const sidebar = screen.getByRole("navigation", { name: "Main navigation" });

    expect(within(sidebar).getByText("Loading the folder list")).toBeDefined();
    expect(within(sidebar).queryByText("You have no folders yet")).toBeNull();
    await openField("Folder");
    const folderPopup = document.querySelector("[data-slot='picker-popup']");
    expect(folderPopup?.querySelector("[data-slot='picker-loading']")?.textContent).toBe("Loading the folders");
    expect(folderPopup?.textContent).not.toContain("You have no folders yet");

    await act(async () => {
      server.foldersGate.release();
      await Promise.resolve();
    });

    await within(sidebar).findByRole("link", { name: "Work", hidden: true });
    expect(within(sidebar).queryByText("Loading the folder list")).toBeNull();
    await waitFor(() => {
      expect(document.querySelector("[data-slot='picker-loading']")).toBeNull();
    });
    expect(await screen.findByRole("option", { name: "Work", hidden: true })).toBeDefined();
  });

  it("say the tags are loading in the field, and not that there are none", async () => {
    stubServer();
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Example docs" });

    await openField("Tags");

    const popup = document.querySelector("[data-slot='multi-pick-popup']");
    expect(popup?.querySelector("[data-slot='multi-pick-loading']")?.textContent).toBe("Loading the tags");
    expect(popup?.textContent).not.toContain("You have no tags yet");
  });

  it("do not make a folder of the address stale before the folder list has been read", async () => {
    const server = stubServer();
    await openApp(`/bookmarks?folderId=${GONE}`);
    await screen.findByRole("link", { name: "Example docs" });

    expect(screen.queryByText("That folder no longer exists")).toBeNull();
    expect(window.location.search).toBe(`?folderId=${GONE}`);

    await act(async () => {
      server.foldersGate.release();
      await Promise.resolve();
    });

    await screen.findByText("That folder no longer exists");
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(server.lists().at(-1)?.get("folderId")).toBeNull();
  });
});
