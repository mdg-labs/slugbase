import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The toolbar of the bookmark list (doc 03 section 3.1) against the handlers generated from openapi.json: one row of
// controls with no visible labels in a fixed order, a Filters button that counts the filters its panel holds and opens it
// and gives focus back when it closes, a row of chips under it only while a filter is set, and the page size beside the
// button that loads more. The failure scenarios are a control that shows a label again (the bar reads as a form), a count
// that misses a kind of filter, a panel that does not close with Escape or loses the member's place, a chip row that stays
// when nothing narrows the list, and a control that no longer writes its value to the address.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Folder = ComponentTypes["schemas"]["Folder"];
type Tag = ComponentTypes["schemas"]["Tag"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const WORK = "0192f3a0-dddd-7000-8000-000000000001";
const TAG_GO = "0192f3a0-eeee-7000-8000-000000000001";
const TAG_RUST = "0192f3a0-eeee-7000-8000-000000000002";

function folder(id: string, name: string): Folder {
  return { id, ownerId: OWNER, name, icon: "folder", color: 2, bookmarkCount: 0, version: 1, createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" };
}

function tag(id: string, name: string): Tag {
  return { id, name, bookmarkCount: 0, createdAt: "2026-10-01T08:00:00.000Z" };
}

function bookmark(n: number): Bookmark {
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
  };
}

function serve(nextCursor: string | null = null): void {
  const items = [bookmark(1)];
  server.use(
    ...createHandlers(document_, {
      scenario: {
        name: "toolbar",
        fixtures: {
          listBookmarks: { items, nextCursor, total: nextCursor === null ? items.length : 50 },
          listFolders: { items: [folder(WORK, "Work")], nextCursor: null, total: 1 },
          listTags: { items: [tag(TAG_GO, "go"), tag(TAG_RUST, "rust")], nextCursor: null, total: 2 },
        },
      },
    }),
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
  await screen.findByRole("link", { name: "Bookmark 1" });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

function toolbar(): HTMLElement {
  return screen.getByRole("region", { name: "Filter and sort the bookmarks" });
}

async function openFilters(): Promise<HTMLElement> {
  await press(within(toolbar()).getByRole("button", { name: /^Filters/ }));
  return screen.findByRole("dialog", { name: "Filters" });
}

/** Whether the element or one of its ancestors is drawn for assistive technology alone (the `sr-only` rule). */
function hiddenOnScreen(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (node.className.includes("sr-only")) {
      return true;
    }
  }
  return false;
}

function search(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

describe("the toolbar row", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("holds the controls in the order search, scope, Filters, sort and view, each named and none labelled on screen", async () => {
    serve();
    await openApp("/bookmarks");

    const bar = within(toolbar());
    const controls = [
      bar.getByRole("searchbox", { name: "Search" }),
      bar.getByRole("radio", { name: "All" }),
      bar.getByRole("radio", { name: "Mine" }),
      bar.getByRole("button", { name: "Filters" }),
      bar.getByRole("combobox", { name: "Sort by" }),
      bar.getByRole("radio", { name: "Grid" }),
      bar.getByRole("radio", { name: "Table" }),
    ];
    for (const [index, control] of controls.entries()) {
      const next = controls[index + 1];
      if (next !== undefined) {
        expect(control.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING, `control ${String(index)} comes before the next`).toBeTruthy();
      }
    }
    // The names are kept for assistive technology and drawn for nobody: no label of the bar is on screen.
    for (const name of ["Search", "Scope", "Sort by", "View"]) {
      expect(hiddenOnScreen(bar.getByText(name, { selector: "label, span" })), name).toBe(true);
    }
    // What the panel holds is not in the row, and the hint about tags is not shown until the panel is.
    expect(bar.queryByText("Show only")).toBeNull();
    expect(screen.queryByText(/must carry every tag/)).toBeNull();
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("writes the scope, the sort and the view to the address as it always did", async () => {
    serve();
    await openApp("/bookmarks");

    await press(within(toolbar()).getByRole("radio", { name: "Mine" }));
    await waitFor(() => {
      expect(search().get("scope")).toBe("mine");
    });
    await press(within(toolbar()).getByRole("radio", { name: "Table" }));
    await waitFor(() => {
      expect(search().get("view")).toBe("table");
    });
    await press(within(toolbar()).getByRole("radio", { name: "All" }));
    await waitFor(() => {
      expect(search().has("scope")).toBe(false);
    });
    expect(search().get("view")).toBe("table");
  });
});

describe("the Filters button and its panel", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("counts the folder, each tag and each show-only switch that is set, and not the search, the scope or the sort", async () => {
    serve();
    await openApp(`/bookmarks?folderId=${WORK}&tag=${TAG_GO}&tag=${TAG_RUST}&pinned=true&q=site&scope=mine&sort=oldest`);

    expect(within(toolbar()).getByRole("button", { name: "Filters, 4 set" })).toBeDefined();

    const panel = within(await openFilters());
    await waitFor(() => {
      expect(panel.getByRole<HTMLInputElement>("combobox", { name: "Folder" }).value).toBe("Work");
    });
    expect(panel.getByRole("checkbox", { name: "Pinned" }).getAttribute("aria-checked")).toBe("true");
    expect(panel.getByRole("checkbox", { name: "Has slug" }).getAttribute("aria-checked")).toBe("false");
    // The hint about tags is shown in the panel only.
    expect(panel.getByText("A bookmark must carry every tag chosen, up to 10.")).toBeDefined();
  });

  it("shows no count while no filter of the panel is set", async () => {
    serve();
    await openApp("/bookmarks?q=site&scope=mine");

    expect(within(toolbar()).getByRole("button", { name: "Filters" })).toBeDefined();
  });

  it("closes on Escape and gives focus back to the Filters button", async () => {
    serve();
    await openApp("/bookmarks");
    const button = within(toolbar()).getByRole("button", { name: "Filters" });
    button.focus();
    await press(button);
    const panel = await screen.findByRole("dialog", { name: "Filters" });

    await act(async () => {
      fireEvent.keyDown(panel, { key: "Escape" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(within(toolbar()).getByRole("button", { name: "Filters" }));
    });
  });
});

describe("the active filters under the row", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("appear with Clear filters once a filter is set from the panel and go with the last one", async () => {
    serve();
    await openApp("/bookmarks");
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();

    await press(within(await openFilters()).getByRole("checkbox", { name: "Has slug" }));
    await press(within(screen.getByRole("dialog", { name: "Filters" })).getByRole("button", { name: "Close filters" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
    });

    const chips = within(await screen.findByRole("list", { name: "Active filters" }));
    expect(chips.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Has slug"]);
    expect(within(toolbar()).getByRole("button", { name: "Clear filters" })).toBeDefined();

    await press(chips.getByRole("button", { name: "Remove filter: Has slug" }));

    await waitFor(() => {
      expect(search().has("hasSlug")).toBe(false);
    });
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("are taken off by Clear filters, which keeps the sort, the view and the size", async () => {
    serve();
    await openApp(`/bookmarks?folderId=${WORK}&tag=${TAG_GO}&hasSlug=true&q=site&scope=mine&sort=oldest&view=table&size=48`);

    await press(await within(toolbar()).findByRole("button", { name: "Clear filters" }));

    await waitFor(() => {
      expect(search().get("sort")).toBe("oldest");
    });
    expect([...search().keys()].toSorted()).toEqual(["size", "sort", "view"]);
    expect(search().get("view")).toBe("table");
    expect(search().get("size")).toBe("48");
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
  });

  it("name each tag of the address and take that one tag off", async () => {
    serve();
    await openApp(`/bookmarks?tag=${TAG_GO}&tag=${TAG_RUST}`);

    const chips = within(await screen.findByRole("list", { name: "Active filters" }));
    await waitFor(() => {
      expect(chips.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Tag: go", "Tag: rust"]);
    });

    await press(chips.getByRole("button", { name: "Remove filter: Tag: go" }));

    await waitFor(() => {
      expect(chips.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Tag: rust"]);
    });
    const address = decodeURIComponent(window.location.search);
    expect(address).toContain(TAG_RUST);
    expect(address).not.toContain(TAG_GO);
  });

  it("names a tag of the address that the member does not have with the same prefix, and takes it off", async () => {
    serve();
    await openApp("/bookmarks?tag=0192f3a0-eeee-7000-8000-000000000099");

    const chips = within(await screen.findByRole("list", { name: "Active filters" }));
    await waitFor(() => {
      expect(chips.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Tag: unknown"]);
    });

    await press(chips.getByRole("button", { name: "Remove filter: Tag: unknown" }));

    await waitFor(() => {
      expect(search().has("tag")).toBe(false);
    });
  });
});

describe("the size of a load", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is chosen in the row of the button that loads more, named for assistive technology and worded in its own text", async () => {
    serve("cursor-1");
    await openApp("/bookmarks");

    const row = document.querySelector<HTMLElement>("[data-slot='load-more']");
    expect(row).not.toBeNull();
    const size = within(row as HTMLElement).getByRole("combobox", { name: "Bookmarks per load" });
    expect(size.textContent).toContain("24 per load");
    expect(within(row as HTMLElement).getByRole("button", { name: "Load more" })).toBeDefined();
    // The field's label is not drawn above the select.
    expect(hiddenOnScreen(within(row as HTMLElement).getByText("Bookmarks per load", { selector: "label" }))).toBe(true);
  });
});
