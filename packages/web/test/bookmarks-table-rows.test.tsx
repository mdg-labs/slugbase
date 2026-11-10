import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The rows of the bookmarks table are drawn again only when something they show changed (doc 03 section 3.3): a
// selection change draws the rows whose checkbox changed, not the page. The failure scenarios are every row of a page of
// bookmarks drawn again for one click, and a row that is not drawn again when its own checkbox, its pin or its tab stop
// changed and so shows the old value. Each row's folder cell is counted, since the table draws it once
// for each time the row is drawn.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];

const drawn = vi.hoisted(() => new Map<string, number>());

vi.mock("../src/bookmarks/bookmark-labels.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/bookmarks/bookmark-labels.tsx")>();
  return {
    ...original,
    FolderDots: (props: Parameters<typeof original.FolderDots>[0]) => {
      const name = props.folders[0]?.name ?? "";
      drawn.set(name, (drawn.get(name) ?? 0) + 1);
      return createElement(original.FolderDots, props);
    },
  };
});

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const ROWS = 12;

const idOf = (n: number): string => `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`;
const folderOf = (n: number): string => `Folder ${String(n)}`;

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
    folders: [{ id: `0192f3a0-cccc-7000-8000-${String(n).padStart(12, "0")}`, name: folderOf(n), icon: "folder", color: 1 }],
    tags: [],
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

const server = createMockServer();
const document_ = readOpenApiDocument();

/** A server that holds the bookmarks and applies a pin to the first of them. */
function useServer(): void {
  let stored = Array.from({ length: ROWS }, (_, index) => bookmark(index + 1));
  server.use(
    ...createResolverHandlers(document_, {
      listBookmarks: () => json({ items: stored, nextCursor: null, total: stored.length }),
      updateBookmark: () => {
        stored = stored.map((item, index) => (index === 0 ? { ...item, pinned: true, version: 4 } : item));
        return json(stored[0]);
      },
    }),
    ...createHandlers(document_, { scenario: { name: "table-rows" } }),
  );
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  restoreWait();
  server.close();
});

beforeEach(() => {
  drawn.clear();
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

async function openTable(): Promise<void> {
  useServer();
  window.history.replaceState(null, "", "/bookmarks?view=table");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("table", { name: "Bookmarks" });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

const box = (n: number): HTMLElement => screen.getByRole("checkbox", { name: `Select Bookmark ${String(n)}` });

/** The numbers of the rows drawn since the counts were last cleared. */
function drawnRows(): number[] {
  return Array.from({ length: ROWS }, (_, index) => index + 1).filter((n) => (drawn.get(folderOf(n)) ?? 0) > 0);
}

describe("the rows of the bookmarks table", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("draws only the row whose checkbox changed when a bookmark is selected and again when it is cleared", async () => {
    await openTable();
    expect(drawnRows()).toHaveLength(ROWS);

    drawn.clear();
    await press(box(3));
    expect(box(3).getAttribute("aria-checked")).toBe("true");
    expect(drawnRows()).toEqual([3]);

    await press(box(5));
    drawn.clear();
    await press(box(3));
    expect(box(3).getAttribute("aria-checked")).toBe("false");
    expect(box(5).getAttribute("aria-checked")).toBe("true");
    expect(drawnRows()).toEqual([3]);
  });

  it("marks the selected rows and the bar counts them while the other rows keep their state", async () => {
    await openTable();

    await press(box(2));
    await press(box(7));

    expect(within(screen.getByRole("toolbar", { name: "Selected bookmarks" })).getByText("2 selected")).toBeDefined();
    const selected = Array.from(document.querySelectorAll<HTMLElement>("tr[data-state='selected']")).map((row) => row.dataset.itemId);
    expect(selected).toEqual([idOf(2), idOf(7)]);
    expect(screen.getAllByRole("checkbox").filter((element) => element.getAttribute("aria-checked") === "true")).toHaveLength(2);
  });

  it("draws the row again when its pin changes and keeps its checkbox", async () => {
    await openTable();
    await press(box(1));
    expect(screen.queryByRole("img", { name: "Pinned" })).toBeNull();

    drawn.clear();
    await press(screen.getByRole("button", { name: "Actions for Bookmark 1" }));
    await press(await screen.findByRole("menuitem", { name: "Pin" }));

    await screen.findByRole("img", { name: "Pinned" });
    expect(screen.getByRole("link", { name: "Bookmark 1" }).closest("tr")?.querySelector("[role='img'][aria-label='Pinned']")).not.toBeNull();
    expect(box(1).getAttribute("aria-checked")).toBe("true");
    expect(drawnRows()).toEqual([1]);
  });

  it("moves the tab stop to the row that has it and draws only the two rows", async () => {
    await openTable();
    const stops = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>("tr[data-item-id]")).map((row) => row.getAttribute("tabindex"));
    expect(stops()[0]).toBe("0");
    expect(stops().slice(1).every((value) => value === "-1")).toBe(true);

    drawn.clear();
    await act(async () => {
      document.querySelectorAll<HTMLElement>("tr[data-item-id]")[3]?.focus();
      await Promise.resolve();
    });

    expect(stops()[3]).toBe("0");
    expect(stops().filter((value) => value === "0")).toHaveLength(1);
    expect(drawnRows()).toEqual([1, 4]);
  });

  it("shows the order a header sets and keeps the checkbox of a selected row", async () => {
    await openTable();
    await press(box(2));
    // The table is a grid while anything is selected.
    const titleHeader = (): HTMLElement => document.querySelectorAll<HTMLElement>("th")[1] as HTMLElement;
    expect(titleHeader().getAttribute("aria-sort")).toBe("none");

    await press(within(titleHeader()).getByRole("button"));

    await waitFor(() => {
      expect(titleHeader().getAttribute("aria-sort")).toBe("ascending");
    });
    expect(box(2).getAttribute("aria-checked")).toBe("true");
  });
});
