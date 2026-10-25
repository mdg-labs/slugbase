import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, meOf, allowSlowRender, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The keyboard shortcuts of the bookmark list and of the app (doc 03 section 14) against the handlers generated from
// openapi.json. The failure scenarios are a shortcut that fires after the account turned single-key shortcuts off or from
// inside a text field or an overlay, a key that opens the bookmark behind the control that has focus, a Ctrl Enter that
// opens an address that is not a web address, an Escape that clears the filters before the selection, a `G` sequence
// that outlives its moment, and a grid role that stays on once the selection is gone.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const LIST = "/api/v1/bookmarks";

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
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

function page(items: readonly Bookmark[]): unknown {
  return { items, nextCursor: null, total: items.length };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: Promise<string>;
}

let calls: Call[] = [];

function use(scenario: Omit<Scenario, "name"> = {}): void {
  server.use(...createHandlers(document_, { scenario: { name: "shortcuts", ...scenario } }));
}

function to(method: string, path: string): Call[] {
  return calls.filter((call) => call.method === method && call.path === path);
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    const clone = request.clone();
    calls.push({ method: request.method, path: new URL(request.url).pathname, body: request.method === "GET" ? Promise.resolve("") : clone.text() });
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
  // jsdom cannot navigate; a followed link would only log that.
  document.addEventListener("click", stayOnPage);
});

afterEach(() => {
  document.removeEventListener("click", stayOnPage);
  vi.restoreAllMocks();
});

function stayOnPage(event: MouseEvent): void {
  event.preventDefault();
}

const ACCOUNT = meOf(ACCOUNT_BODY);
const ACCOUNT_OFF = meOf({ ...ACCOUNT_BODY, singleKeyShortcuts: false });

async function openApp(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function key(init: KeyboardEventInit, target: Element | Window = window): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(target, init);
    await Promise.resolve();
  });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

/** The cards or rows of the list, in order. */
function items(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-item-id]"));
}

function item(n: number): HTMLElement {
  const found = items().find((element) => element.dataset.itemId === idOf(n));
  expect(found).toBeDefined();
  return found as HTMLElement;
}

function focusedNumber(): number | undefined {
  const id = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.itemId : undefined;
  const index = items().findIndex((element) => element.dataset.itemId === id);
  return index === -1 ? undefined : index + 1;
}

async function openList(count = 3, scenario: Omit<Scenario, "name"> = {}, path = "/bookmarks"): Promise<void> {
  use({ fixtures: { getMe: ACCOUNT, listBookmarks: page(Array.from({ length: count }, (_, index) => bookmark(index + 1))), ...scenario.fixtures }, ...scenario });
  await openApp(path);
  await screen.findByRole("link", { name: "Bookmark 1" });
}

describe("moving through the list", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("moves focus to the next and previous card with J and K and stops at the ends", async () => {
    await openList();

    await key({ key: "j" });
    expect(focusedNumber()).toBe(1);
    await key({ key: "j" }, item(1));
    expect(focusedNumber()).toBe(2);
    await key({ key: "j" }, item(2));
    await key({ key: "j" }, item(3));
    expect(focusedNumber()).toBe(3);
    await key({ key: "k" }, item(3));
    expect(focusedNumber()).toBe(2);
    await key({ key: "k" }, item(2));
    await key({ key: "k" }, item(1));
    expect(focusedNumber()).toBe(1);
  });

  it("moves with the arrow keys, from the page and from inside a card", async () => {
    await openList();

    await key({ key: "ArrowDown" });
    expect(focusedNumber()).toBe(1);
    const checkbox = screen.getByRole("checkbox", { name: "Select Bookmark 1" });
    checkbox.focus();
    await key({ key: "ArrowDown" }, checkbox);
    expect(focusedNumber()).toBe(2);
    await key({ key: "ArrowUp" }, item(2));
    expect(focusedNumber()).toBe(1);
  });

  it("leaves the arrow keys to a control outside the list", async () => {
    await openList();
    const button = screen.getByRole("button", { name: "New bookmark" });
    button.focus();

    await key({ key: "ArrowDown" }, button);

    expect(focusedNumber()).toBeUndefined();
    expect(document.activeElement).toBe(button);
  });

  it("makes one card the stop on the Tab key: the first, then the one focus was last in", async () => {
    await openList();
    expect(items().map((element) => element.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

    await act(async () => {
      item(3).focus();
      await Promise.resolve();
    });

    expect(items().map((element) => element.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
    await key({ key: "k" }, item(3));
    expect(items().map((element) => element.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("moves through the rows of the table the same way", async () => {
    await openList(3, {}, "/bookmarks?view=table");
    await screen.findByRole("table", { name: "Bookmarks" });

    await key({ key: "j" });
    await key({ key: "j" }, item(1));

    expect(focusedNumber()).toBe(2);
    expect(items().map((element) => element.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });
});

describe("acting on the focused bookmark", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("follows the focused card with Enter, and counts the open", async () => {
    await openList();
    const link = screen.getByRole("link", { name: "Bookmark 2" });
    const clicked = vi.fn<(event: MouseEvent) => void>();
    link.addEventListener("click", clicked);
    item(2).focus();

    await key({ key: "Enter" }, item(2));

    expect(clicked).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(to("POST", `${LIST}/${idOf(2)}/open`)).toHaveLength(1);
    });
  });

  it("leaves Enter to the link inside the card that has focus, which the browser follows itself", async () => {
    await openList();
    const link = screen.getByRole("link", { name: "Bookmark 2" });
    const clicked = vi.fn<() => void>();
    link.addEventListener("click", clicked);
    link.focus();

    await key({ key: "Enter" }, link);
    await key({ key: "Enter", ctrlKey: true }, link);

    expect(clicked).not.toHaveBeenCalled();
    expect(to("POST", `${LIST}/${idOf(2)}/open`)).toHaveLength(0);
  });

  it("opens the focused bookmark in a new tab with Ctrl Enter or Command Enter, without an opener", async () => {
    await openList();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    item(2).focus();

    await key({ key: "Enter", ctrlKey: true }, item(2));
    await key({ key: "Enter", metaKey: true }, item(2));

    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith("https://site2.example.com/page", "_blank", "noopener,noreferrer");
    await waitFor(() => {
      expect(to("POST", `${LIST}/${idOf(2)}/open`)).toHaveLength(2);
    });
  });

  it("opens nothing for a bookmark whose address is not a web address", async () => {
    await openList(2, { fixtures: { getMe: ACCOUNT, listBookmarks: page([bookmark(1), bookmark(2, { url: "ftp://files.example.com/x", host: "files.example.com" })]) } });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    item(2).focus();

    await key({ key: "Enter", ctrlKey: true }, item(2));
    await key({ key: "Enter" }, item(2));

    expect(open).not.toHaveBeenCalled();
    expect(to("POST", `${LIST}/${idOf(2)}/open`)).toHaveLength(0);
  });

  it("edits the focused bookmark with E", async () => {
    await openList(3, { fixtures: { getMe: ACCOUNT, listBookmarks: page([bookmark(1), bookmark(2), bookmark(3)]), getBookmark: bookmark(2) } });
    item(2).focus();

    await key({ key: "e" }, item(2));

    await screen.findByRole("dialog", { name: "Edit bookmark" });
    expect(window.location.search).toBe(`?bookmark=${idOf(2)}`);
  });

  it("does nothing for E, P or Enter while no card has focus", async () => {
    await openList();

    await key({ key: "e" });
    await key({ key: "p" });
    await key({ key: "Enter" });

    expect(window.location.search).toBe("");
    expect(to("PATCH", `${LIST}/${idOf(1)}`)).toHaveLength(0);
  });

  it("pins the focused bookmark with P, and unpins a pinned one", async () => {
    await openList(2, { fixtures: { getMe: ACCOUNT, listBookmarks: page([bookmark(1), bookmark(2, { pinned: true })]), updateBookmark: bookmark(1) } });

    item(1).focus();
    await key({ key: "p" }, item(1));
    await waitFor(() => {
      expect(to("PATCH", `${LIST}/${idOf(1)}`)).toHaveLength(1);
    });
    expect(JSON.parse(await (to("PATCH", `${LIST}/${idOf(1)}`)[0] as Call).body)).toEqual({ pinned: true });

    item(2).focus();
    await key({ key: "p" }, item(2));
    await waitFor(() => {
      expect(to("PATCH", `${LIST}/${idOf(2)}`)).toHaveLength(1);
    });
    expect(JSON.parse(await (to("PATCH", `${LIST}/${idOf(2)}`)[0] as Call).body)).toEqual({ pinned: false });
  });

  it("switches between the grid and the table with V", async () => {
    await openList();
    expect(screen.queryByRole("table")).toBeNull();

    await key({ key: "v" });
    await screen.findByRole("table", { name: "Bookmarks" });
    expect(window.location.search).toBe("?view=table");

    await key({ key: "v" });
    await waitFor(() => {
      expect(screen.queryByRole("table")).toBeNull();
    });
    expect(window.location.search).toBe("?view=grid");
  });
});

describe("Escape", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("clears the selection first, then the filters, one step for each press", async () => {
    await openList(2, {}, "/bookmarks?pinned=true&sort=most_used");
    await press(screen.getByRole("checkbox", { name: "Select Bookmark 1" }));
    expect(screen.getByRole("toolbar", { name: "Selected bookmarks" })).toBeDefined();

    await key({ key: "Escape" });
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(window.location.search).toBe("?pinned=true&sort=most_used");

    await key({ key: "Escape" });
    await waitFor(() => {
      expect(window.location.search).toBe("?sort=most_used");
    });
  });

  it("leaves the selection and the filters to an overlay that holds focus", async () => {
    await openList(2, {}, "/bookmarks?pinned=true");
    await press(screen.getByRole("checkbox", { name: "Select Bookmark 1" }));
    const overlay = window.document.createElement("div");
    overlay.setAttribute("role", "dialog");
    const inside = window.document.createElement("button");
    overlay.append(inside);
    window.document.body.append(overlay);

    await key({ key: "Escape" }, inside);
    overlay.remove();

    expect(screen.getByRole("toolbar", { name: "Selected bookmarks" })).toBeDefined();
    expect(window.location.search).toBe("?pinned=true");
  });

  it("does nothing when there is neither a selection nor a filter", async () => {
    await openList(2, {}, "/bookmarks?sort=most_used");

    await key({ key: "Escape" });

    expect(window.location.search).toBe("?sort=most_used");
  });
});

describe("the list is an ARIA grid only while a selection is active", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is a list, becomes a grid of rows and cells when a card is selected, and a list again once cleared", async () => {
    await openList();
    expect(screen.getByRole("list", { name: "Bookmarks" })).toBeDefined();
    expect(screen.queryByRole("grid")).toBeNull();

    await press(screen.getByRole("checkbox", { name: "Select Bookmark 2" }));

    const grid = screen.getByRole("grid", { name: "Bookmarks" });
    expect(within(grid).getAllByRole("row")).toHaveLength(3);
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(3);
    expect(screen.queryByRole("list", { name: "Bookmarks" })).toBeNull();

    await key({ key: "Escape" });
    expect(screen.getByRole("list", { name: "Bookmarks" })).toBeDefined();
    expect(screen.queryByRole("grid")).toBeNull();
  });

  it("makes the table a grid while a row is selected", async () => {
    await openList(2, {}, "/bookmarks?view=table");
    expect(await screen.findByRole("table", { name: "Bookmarks" })).toBeDefined();

    await press(screen.getByRole("checkbox", { name: "Select Bookmark 1" }));

    expect(screen.getByRole("grid", { name: "Bookmarks" })).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("the shortcuts of the app", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("opens the New bookmark modal with C, on the bookmarks page and on Home", async () => {
    await openList();
    await key({ key: "c" });
    await screen.findByRole("dialog", { name: "New bookmark" });
    expect(window.location.search).toBe("?new=1");
    await press(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await press(screen.getByRole("link", { name: "Home" }));
    await screen.findByRole("heading", { level: 1 });
    await key({ key: "c" });

    await screen.findByRole("dialog", { name: "New bookmark" });
  });

  it("goes to Home and to Bookmarks with G then H and G then B", async () => {
    await openList();

    await key({ key: "g" });
    await key({ key: "h" });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });

    await key({ key: "g" });
    await key({ key: "b" });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/bookmarks");
    });
  });

  it("goes nowhere on H or B alone, after a pause, or after another key", async () => {
    await openList();

    await key({ key: "h" });
    await key({ key: "b" });
    await key({ key: "g" });
    const later = Date.now() + 5000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    await key({ key: "h" });
    vi.spyOn(Date, "now").mockRestore();
    await key({ key: "g" });
    await act(async () => {
      fireEvent.keyDown(window, { key: "x" });
      fireEvent.keyUp(window, { key: "x" });
      await Promise.resolve();
    });
    await key({ key: "h" });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(window.location.pathname).toBe("/bookmarks");
  });

  it("opens a dialog of the shortcuts with ?, from any page, with the keys in kbd elements", async () => {
    await openList();

    await key({ key: "?", shiftKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const keys = Array.from(dialog.querySelectorAll("kbd[data-slot='kbd']")).map((element) => element.textContent);
    expect(keys).toEqual(expect.arrayContaining(["C", "G", "H", "B", "?", "J", "K", "↑", "↓", "Ctrl", "⌘", "Enter", "E", "P", "X", "⇧", "A", "V", "Esc"]));
    expect(within(dialog).getByText("New bookmark")).toBeDefined();
    expect(within(dialog).getByText("Go to Home")).toBeDefined();
    expect(within(dialog).getByText("Single-key shortcuts work anywhere except in a text field or inside an open dialog, menu or list box.")).toBeDefined();
    expect(within(dialog).getByText("Close the overlay that has focus, then clear the selection, then clear the filters")).toBeDefined();
    await press(within(dialog).getByRole("button", { name: "Close the shortcut list" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("lists the shortcuts in German with the German names of the keys", async () => {
    use({ fixtures: { getMe: meOf({ ...ACCOUNT_BODY, locale: "de" }), listBookmarks: page([bookmark(1)]) } });
    await openApp("/");

    await key({ key: "?", shiftKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Tastenkürzel" });
    expect(within(dialog).getByText("Neues Lesezeichen")).toBeDefined();
    expect(within(dialog).getByText("Einzeltasten-Kürzel funktionieren überall außer in Textfeldern und in geöffneten Dialogen, Menüs oder Listenfeldern.")).toBeDefined();
    expect(within(dialog).getByText("Das Overlay mit dem Fokus schließen, dann die Auswahl aufheben, dann die Filter zurücksetzen")).toBeDefined();
    const keys = Array.from(dialog.querySelectorAll("kbd[data-slot='kbd']")).map((element) => element.textContent);
    expect(keys).toEqual(expect.arrayContaining(["Strg", "Eingabe", "Esc"]));
    expect(keys).not.toContain("Ctrl");
  });
});

describe("with single-key shortcuts off", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("fires none of them, and still follows Ctrl Enter on the focused card", async () => {
    use({ fixtures: { getMe: ACCOUNT_OFF, listBookmarks: page([bookmark(1), bookmark(2)]), updateBookmark: bookmark(1) } });
    await openApp("/bookmarks?pinned=true");
    await screen.findByRole("link", { name: "Bookmark 1" });
    await press(screen.getByRole("checkbox", { name: "Select Bookmark 1" }));
    item(1).focus();
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    for (const init of [{ key: "j" }, { key: "k" }, { key: "ArrowDown" }, { key: "Enter" }, { key: "e" }, { key: "p" }, { key: "v" }, { key: "c" }, { key: "?", shiftKey: true }, { key: "Escape" }]) {
      await key(init, item(1));
    }
    await key({ key: "g" }, item(1));
    await key({ key: "h" }, item(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(focusedNumber()).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.pathname + window.location.search).toBe("/bookmarks?pinned=true");
    expect(screen.getByRole("toolbar", { name: "Selected bookmarks" })).toBeDefined();
    expect(to("PATCH", `${LIST}/${idOf(1)}`)).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();

    await key({ key: "Enter", ctrlKey: true }, item(1));

    expect(open).toHaveBeenCalledWith("https://site1.example.com/page", "_blank", "noopener,noreferrer");
  });

  it("leaves the arrow keys to the browser", async () => {
    use({ fixtures: { getMe: ACCOUNT_OFF, listBookmarks: page([bookmark(1)]) } });
    await openApp("/bookmarks");
    await screen.findByRole("link", { name: "Bookmark 1" });
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });

    await act(async () => {
      window.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(false);
  });
});

describe("in a text field", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("fires no single-key shortcut", async () => {
    await openList();
    const field = window.document.createElement("input");
    window.document.body.append(field);
    field.focus();

    for (const init of [{ key: "c" }, { key: "?", shiftKey: true }, { key: "v" }, { key: "j" }, { key: "g" }, { key: "h" }]) {
      await key(init, field);
    }
    field.remove();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.pathname + window.location.search).toBe("/bookmarks");
    expect(focusedNumber()).toBeUndefined();
  });
});
