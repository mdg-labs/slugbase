import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The bookmark modal (doc 02 sections 5.2 and 5.3, doc 03 section 4) against the handlers generated from openapi.json,
// through the app's own API client. The failure scenarios are a save that overwrites a change made elsewhere (no
// If-Match, or the wrong version), a duplicate that blocks the save or is not warned about, a delete that is sent without
// the confirmation, and a failed request shown as success or as an empty form.
// What the generated handlers cannot say (the problem codes of a limit or a refused address, the page's paste handling and
// the keyboard) is in bookmark-modal-failures.test.tsx, which stubs the transport.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const ID = "0192f3a0-aaaa-7000-8000-000000000001";
const OTHER_ID = "0192f3a0-aaaa-7000-8000-000000000002";

const BOOKMARK: Bookmark = {
  id: ID,
  ownerId: "0192f3a0-bbbb-7000-8000-000000000001",
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

const OTHER: Bookmark = { ...BOOKMARK, id: OTHER_ID, url: "https://example.org/read", host: "example.org", title: "Already saved", version: 1 };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly ifMatch: string | null;
  readonly body: Promise<string>;
}

let calls: Call[] = [];

function use(scenario: Omit<Scenario, "name"> = {}): void {
  server.use(...createHandlers(document_, { scenario: { name: "bookmarks", ...scenario } }));
}

function to(method: string, path: string): Call[] {
  return calls.filter((call) => call.method === method && call.path === path);
}

async function bodyOf(call: Call | undefined): Promise<unknown> {
  expect(call).toBeDefined();
  return JSON.parse((await call?.body) ?? "null") as unknown;
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    const clone = request.clone();
    calls.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      ifMatch: request.headers.get("If-Match"),
      body: request.method === "GET" || request.method === "DELETE" ? Promise.resolve("") : clone.text(),
    });
  });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  calls = [];
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

async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    await Promise.resolve();
  });
}

/** The bookmark modal; a toast is a dialog too. */
function modal(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: /^(New|Edit) bookmark$/ });
}

async function openEdit(): Promise<HTMLElement> {
  use({ fixtures: { getBookmark: BOOKMARK, listBookmarks: { items: [], nextCursor: null, total: 0 } } });
  await openApp(`/bookmarks?bookmark=${ID}`);
  const dialog = await screen.findByRole("dialog", { name: "Edit bookmark" });
  await waitFor(() => {
    expect(within(dialog).getByLabelText<HTMLInputElement>("URL").value).toBe(BOOKMARK.url);
  });
  return dialog;
}

describe("creating a bookmark", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("opens from the New bookmark button of the top bar, saves the address and the title, and closes", async () => {
    use({ fixtures: { createBookmark: BOOKMARK } });
    await openApp("/");
    await press(await screen.findByRole("button", { name: "New bookmark" }));
    const dialog = await screen.findByRole("dialog", { name: "New bookmark" });
    expect(window.location.search).toBe("?new=1");

    await type("URL", "https://example.com/docs");
    await type("Title", "  Example docs  ");
    await press(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(await bodyOf(to("POST", "/api/v1/bookmarks")[0])).toEqual({ url: "https://example.com/docs", title: "Example docs" });
    expect(window.location.search).toBe("");
  });

  it("opens prefilled from ?new=1&url=, which is how a pasted address arrives", async () => {
    use({ fixtures: { listBookmarks: { items: [], nextCursor: null, total: 0 } } });
    await openApp(`/?new=1&url=${encodeURIComponent("https://example.com/docs")}`);

    const dialog = await screen.findByRole("dialog", { name: "New bookmark" });
    expect(within(dialog).getByLabelText<HTMLInputElement>("URL").value).toBe("https://example.com/docs");
    await waitFor(() => {
      expect(to("GET", "/api/v1/bookmarks")).toHaveLength(1);
    });
    expect(new URLSearchParams(to("GET", "/api/v1/bookmarks")[0]?.search).get("url")).toBe("https://example.com/docs");
    expect(screen.queryByText("You already saved this address")).toBeNull();
  });

  it("validates with the shared schemas before sending anything", async () => {
    await openApp("/?new=1");
    const dialog = await screen.findByRole("dialog", { name: "New bookmark" });

    await press(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Enter the address to save.")).toBeTruthy();
    expect(within(dialog).getByText("Enter a title.")).toBeTruthy();

    await type("URL", "ftp://example.com/file");
    await type("Title", "A file");
    await press(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Enter an address that starts with http:// or https://.")).toBeTruthy();
    expect(to("POST", "/api/v1/bookmarks")).toHaveLength(0);
  });

  it("warns about a bookmark with the same address, links to it, and still saves", async () => {
    use({ fixtures: { listBookmarks: { items: [OTHER], nextCursor: null, total: 1 }, createBookmark: BOOKMARK, getBookmark: OTHER } });
    await openApp(`/?new=1&url=${encodeURIComponent(OTHER.url)}`);
    const dialog = await screen.findByRole("dialog", { name: "New bookmark" });

    expect(await within(dialog).findByText("You already saved this address")).toBeTruthy();
    expect(within(dialog).getByText(/“Already saved” has the same address/)).toBeTruthy();

    await type("Title", "Again");
    await press(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(to("POST", "/api/v1/bookmarks")).toHaveLength(1);
  });

  it("moves to the existing bookmark when Edit existing is chosen", async () => {
    use({ fixtures: { listBookmarks: { items: [OTHER], nextCursor: null, total: 1 }, getBookmark: OTHER } });
    await openApp(`/?new=1&url=${encodeURIComponent(OTHER.url)}`);

    await press(await screen.findByRole("button", { name: "Edit existing" }));

    expect((await screen.findByLabelText<HTMLInputElement>("Title")).value).toBe("Already saved");
    expect(screen.getByRole("dialog", { name: "Edit bookmark" })).toBeTruthy();
    expect(window.location.search).toBe(`?bookmark=${OTHER_ID}`);
  });

  it("says when the duplicate lookup could not be made, and does not block the save", async () => {
    use({ statuses: { listBookmarks: 422 } });
    await openApp(`/?new=1&url=${encodeURIComponent("https://example.com/docs")}`);

    expect(await screen.findByText("We could not check whether you saved this address already.")).toBeTruthy();
    expect(within(screen.getByRole("dialog", { name: "New bookmark" })).getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(false);
  });
});

describe("editing a bookmark", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows a skeleton while ?bookmark= loads, then the bookmark in the form", async () => {
    use({ fixtures: { getBookmark: BOOKMARK } });
    await openApp(`/bookmarks?bookmark=${ID}`);

    const dialog = await screen.findByRole("dialog", { name: "Edit bookmark" });
    await waitFor(() => {
      expect(within(dialog).getByLabelText<HTMLInputElement>("Title").value).toBe("Example docs");
    });
    expect(screen.queryByRole("status", { name: "Loading the bookmark" })).toBeNull();
  });

  it("sends only what changed, against the loaded version, and closes", async () => {
    const dialog = await openEdit();

    await type("Title", "Example documentation");
    await press(within(dialog).getByRole("switch", { name: "Pinned" }));
    use({ fixtures: { updateBookmark: { ...BOOKMARK, title: "Example documentation", pinned: true, version: 4 }, getBookmark: BOOKMARK } });
    await press(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    const [patch] = to("PATCH", `/api/v1/bookmarks/${ID}`);
    expect(patch?.ifMatch).toBe('"3"');
    expect(await bodyOf(patch)).toEqual({ title: "Example documentation", pinned: true });
  });

  it("sends nothing when nothing changed", async () => {
    const dialog = await openEdit();

    await press(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(to("PATCH", `/api/v1/bookmarks/${ID}`)).toHaveLength(0);
  });

  it("says the bookmark changed elsewhere on a 412, keeps the form, and loads the latest on request", async () => {
    const dialog = await openEdit();
    await type("Title", "My edit");
    use({ statuses: { updateBookmark: 412 }, fixtures: { getBookmark: BOOKMARK } });
    await press(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText("This bookmark changed elsewhere")).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>("Title").value).toBe("My edit");

    use({ fixtures: { getBookmark: { ...BOOKMARK, title: "Changed by someone else", version: 4 } } });
    await press(within(dialog).getByRole("button", { name: "Load the latest" }));

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe("Changed by someone else");
    });
    expect(screen.queryByText("This bookmark changed elsewhere")).toBeNull();

    use({ fixtures: { updateBookmark: { ...BOOKMARK, version: 5 }, getBookmark: BOOKMARK } });
    await type("Title", "Second try");
    await press(within(screen.getByRole("dialog", { name: "Edit bookmark" })).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(to("PATCH", `/api/v1/bookmarks/${ID}`)).toHaveLength(2);
    });
    expect(to("PATCH", `/api/v1/bookmarks/${ID}`)[1]?.ifMatch).toBe('"4"');
  });

  it("says the bookmark could not be loaded when loading the latest fails", async () => {
    const dialog = await openEdit();
    await type("Title", "My edit");
    use({ statuses: { updateBookmark: 412 }, fixtures: { getBookmark: BOOKMARK } });
    await press(within(dialog).getByRole("button", { name: "Save" }));
    await within(dialog).findByText("This bookmark changed elsewhere");

    use({ statuses: { getBookmark: 400 } });
    await press(within(dialog).getByRole("button", { name: "Load the latest" }));

    expect(await within(dialog).findByText("The bookmark could not be loaded. Try again in a moment.")).toBeTruthy();
    expect(within(dialog).queryByText(/could not be saved/)).toBeNull();
  });

  it("says so when the bookmark is not found", async () => {
    use({ statuses: { getBookmark: 404 } });
    await openApp(`/bookmarks?bookmark=${ID}`);

    expect(await screen.findByText("Bookmark not found")).toBeTruthy();
    expect(screen.queryByLabelText("URL")).toBeNull();
    await press(within(screen.getByRole("dialog", { name: "Edit bookmark" })).getAllByRole("button", { name: "Close" })[0] as HTMLElement);
    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(window.location.search).toBe("");
  });

  it("says so, with a retry, when the bookmark cannot be loaded", async () => {
    use({ statuses: { getBookmark: 400 } });
    await openApp(`/bookmarks?bookmark=${ID}`);

    expect(await screen.findByText("The bookmark could not be loaded. Try again in a moment.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Bookmark not found")).toBeNull();
  });
});

describe("closing with unsaved changes", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks first, goes back to the form on Keep editing, and closes on Discard", async () => {
    const dialog = await openEdit();
    await type("Title", "Unsaved");

    await press(within(dialog).getByRole("button", { name: "Cancel" }));
    const guard = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
    await press(within(guard).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe("Unsaved");

    await press(within(screen.getByRole("dialog", { name: "Edit bookmark" })).getByRole("button", { name: "Cancel" }));
    await press(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(to("PATCH", `/api/v1/bookmarks/${ID}`)).toHaveLength(0);
  });

  it("closes without asking when nothing was changed", async () => {
    const dialog = await openEdit();

    await press(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("deleting a bookmark", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("states the consequence, deletes only once confirmed, and closes", async () => {
    const dialog = await openEdit();

    await press(within(dialog).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete this bookmark?" });
    expect(within(confirm).getByText(/deleted for good/)).toBeTruthy();
    expect(to("DELETE", `/api/v1/bookmarks/${ID}`)).toHaveLength(0);

    await press(within(confirm).getByRole("button", { name: "Delete bookmark" }));

    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(to("DELETE", `/api/v1/bookmarks/${ID}`)).toHaveLength(1);
    expect(window.location.search).toBe("");
  });

  it("keeps the modal open and says so when the delete fails", async () => {
    const dialog = await openEdit();
    use({ statuses: { deleteBookmark: 503 }, fixtures: { getBookmark: BOOKMARK } });

    await press(within(dialog).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    await press(within(confirm).getByRole("button", { name: "Delete bookmark" }));

    expect((await within(confirm).findByRole("alert")).textContent).toBe("The bookmark could not be deleted right now. Try again in a moment.");
    expect(screen.getByRole("dialog", { name: "Edit bookmark", hidden: true })).toBeTruthy();
  });

  it("says the delete was rate limited, not that the bookmark could not be saved", async () => {
    const dialog = await openEdit();
    use({ statuses: { deleteBookmark: 429 }, fixtures: { getBookmark: BOOKMARK } });

    await press(within(dialog).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    await press(within(confirm).getByRole("button", { name: "Delete bookmark" }));

    expect((await within(confirm).findByRole("alert")).textContent).toMatch(/^Too many attempts\. Try again/);
  });

  it("offers no delete for a new bookmark", async () => {
    await openApp("/?new=1");
    await screen.findByRole("dialog", { name: "New bookmark" });

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("on a phone", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is a drawer below the md breakpoint", async () => {
    stubMatchMedia(true);
    await openApp("/?new=1");

    await screen.findByRole("dialog", { name: "New bookmark" });
    expect(document.querySelector("[data-slot='drawer-header']")).not.toBeNull();
    expect(document.querySelector("[data-slot='dialog-popup']")).toBeNull();
  });
});
