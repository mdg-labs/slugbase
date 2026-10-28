import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers, type OperationResolver, type Scenario } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The title and description the bookmark modal prefills from the page's own metadata (doc 02 sections 5.2 and 5.4, doc 03 section 4),
// against the handlers generated from openapi.json, through the app's own API client. The failure scenarios are a prefill that
// overwrites what the member typed, a late answer for an address the field no longer holds, a failed read that blocks the save or
// raises an error, and a page's text that is rendered as markup.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Metadata = ComponentTypes["schemas"]["BookmarkMetadata"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const CREATED: Bookmark = {
  id: "0192f3a0-aaaa-7000-8000-000000000001",
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
  version: 1,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
};

const DOCS = "https://example.com/docs";
const BLOG = "https://example.org/blog";
const SPINNER = "Reading the title and description of the page";

function page(overrides: Partial<Metadata> = {}): Metadata {
  return { title: "Docs title", description: "Docs description", siteName: null, canonicalUrl: null, language: null, cached: false, ...overrides };
}

interface Held {
  readonly promise: Promise<Response>;
  readonly settle: (response: Response) => void;
}

function held(): Held {
  let settle: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => {
    settle = done;
  });
  return { promise, settle };
}

let asked: string[] = [];
let created: unknown[] = [];

function use(resolvers: Readonly<Record<string, OperationResolver>> = {}, scenario: Omit<Scenario, "name"> = {}): void {
  server.use(
    ...createResolverHandlers(document_, {
      fetchBookmarkMetadata: async (request) => {
        asked.push(((await request.clone().json()) as { url: string }).url);
        return json(page());
      },
      createBookmark: async (request) => {
        created.push(await request.clone().json());
        return json(CREATED, { status: 201 });
      },
      ...resolvers,
    }),
    ...createHandlers(document_, { scenario: { name: "bookmark-metadata", fixtures: { listBookmarks: { items: [], nextCursor: null, total: 0 } }, ...scenario } }),
  );
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

afterAll(() => {
  restoreWait();
  server.close();
});

beforeEach(() => {
  asked = [];
  created = [];
  use();
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

async function openNew(search = "?new=1"): Promise<HTMLElement> {
  window.history.replaceState(null, "", `/${search}`);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  return screen.findByRole("dialog", { name: "New bookmark" });
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

async function paste(value: string): Promise<void> {
  await act(async () => {
    fireEvent.paste(screen.getByLabelText("URL"));
    fireEvent.change(screen.getByLabelText("URL"), { target: { value } });
    await Promise.resolve();
  });
}

async function leaveUrlField(): Promise<void> {
  await act(async () => {
    fireEvent.blur(screen.getByLabelText("URL"));
    await Promise.resolve();
  });
}

async function enterUrl(value: string): Promise<void> {
  await type("URL", value);
  await leaveUrlField();
}

function titleField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Title");
}

async function save(dialog: HTMLElement): Promise<void> {
  await press(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(created).toHaveLength(1);
  });
}

describe("the metadata prefill of the bookmark modal", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("reads the page when a valid address is pasted, shows the spinner meanwhile, and fills the title and description", async () => {
    const answer = held();
    use({ fetchBookmarkMetadata: () => answer.promise });
    const dialog = await openNew();

    await paste(DOCS);

    expect(await within(dialog).findByRole("status", { name: SPINNER })).toBeTruthy();
    expect(titleField().value).toBe("");
    await act(async () => {
      answer.settle(json(page()));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(titleField().value).toBe("Docs title");
    });
    expect(within(dialog).queryByRole("status", { name: SPINNER })).toBeNull();

    await press(within(dialog).getByRole("button", { name: "More" }));
    expect((await within(dialog).findByLabelText<HTMLTextAreaElement>("Description")).value).toBe("Docs description");
    await save(dialog);
    expect(created).toEqual([{ url: DOCS, title: "Docs title", description: "Docs description" }]);
  });

  it("reads the page when the address field loses focus, once for one address", async () => {
    const dialog = await openNew();

    await enterUrl(DOCS);
    await waitFor(() => {
      expect(titleField().value).toBe("Docs title");
    });
    await leaveUrlField();
    await paste(DOCS);

    expect(asked).toEqual([DOCS]);
    expect(within(dialog).queryByRole("status", { name: SPINNER })).toBeNull();
  });

  it("reads the page of an address the modal opens with", async () => {
    await openNew(`?new=1&url=${encodeURIComponent(DOCS)}`);

    await waitFor(() => {
      expect(titleField().value).toBe("Docs title");
    });
    expect(asked).toEqual([DOCS]);
  });

  it("asks for nothing while the address is not a valid web address", async () => {
    const dialog = await openNew();

    await enterUrl("not an address");
    await enterUrl("ftp://example.com/file");
    await enterUrl("");

    expect(asked).toEqual([]);
    expect(within(dialog).queryByRole("status", { name: SPINNER })).toBeNull();
  });

  it("does not overwrite a title or description the member typed, even when the answer comes after", async () => {
    const answer = held();
    use({ fetchBookmarkMetadata: () => answer.promise });
    const dialog = await openNew();
    await enterUrl(DOCS);
    await within(dialog).findByRole("status", { name: SPINNER });

    await type("Title", "My own title");
    await press(within(dialog).getByRole("button", { name: "More" }));
    await type("Description", "My own words");
    await act(async () => {
      answer.settle(json(page()));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(within(dialog).queryByRole("status", { name: SPINNER })).toBeNull();
    });

    expect(titleField().value).toBe("My own title");
    expect(screen.getByLabelText<HTMLTextAreaElement>("Description").value).toBe("My own words");
    await save(dialog);
    expect(created).toEqual([{ url: DOCS, title: "My own title", description: "My own words" }]);
  });

  it("fills the field that was not edited and keeps the one that was", async () => {
    const dialog = await openNew();
    await type("Title", "Mine");

    await enterUrl(DOCS);

    await press(within(dialog).getByRole("button", { name: "More" }));
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>("Description").value).toBe("Docs description");
    });
    expect(titleField().value).toBe("Mine");
  });

  it("replaces what an earlier address filled, keeps what was typed since, and fills nothing the page does not say", async () => {
    use({
      fetchBookmarkMetadata: async (request) => {
        const { url } = (await request.clone().json()) as { url: string };
        return json(url === DOCS ? page() : page({ title: "Blog title", description: null }));
      },
    });
    const dialog = await openNew();
    await enterUrl(DOCS);
    await waitFor(() => {
      expect(titleField().value).toBe("Docs title");
    });

    await enterUrl(BLOG);
    await waitFor(() => {
      expect(titleField().value).toBe("Blog title");
    });
    await press(within(dialog).getByRole("button", { name: "More" }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("Description").value).toBe("");

    await type("Title", "Kept");
    await enterUrl(DOCS);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>("Description").value).toBe("Docs description");
    });
    expect(titleField().value).toBe("Kept");
  });

  it("ignores the late answer for an address that a newer one replaced", async () => {
    const first = held();
    const second = held();
    use({
      fetchBookmarkMetadata: async (request) => {
        const { url } = (await request.clone().json()) as { url: string };
        asked.push(url);
        return url === DOCS ? first.promise : second.promise;
      },
    });
    const dialog = await openNew();
    await enterUrl(DOCS);
    await waitFor(() => {
      expect(asked).toEqual([DOCS]);
    });
    await enterUrl(BLOG);
    await waitFor(() => {
      expect(asked).toEqual([DOCS, BLOG]);
    });

    await act(async () => {
      second.settle(json(page({ title: "Blog title", description: "Blog description" })));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(titleField().value).toBe("Blog title");
    });
    await act(async () => {
      first.settle(json(page({ title: "Stale title", description: "Stale description" })));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(titleField().value).toBe("Blog title");
    await press(within(dialog).getByRole("button", { name: "More" }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("Description").value).toBe("Blog description");
    expect(within(dialog).queryByRole("status", { name: SPINNER })).toBeNull();
  });

  it("ignores the answer for an address the field no longer holds, and stops the spinner", async () => {
    const answer = held();
    use({ fetchBookmarkMetadata: () => answer.promise });
    const dialog = await openNew();
    await enterUrl(DOCS);
    await within(dialog).findByRole("status", { name: SPINNER });

    await type("URL", `${DOCS}/changed`);
    expect(within(dialog).queryByRole("status", { name: SPINNER })).toBeNull();
    await act(async () => {
      answer.settle(json(page()));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(titleField().value).toBe("");
  });

  it.each([
    ["a page that cannot be read", () => problem(502, "upstream_failed", "req-1")],
    ["an address the server refuses", () => problem(422, "url_not_allowed", "req-2")],
    ["a rate limit", () => problem(429, "rate_limited", "req-3")],
    ["an answer that is not a document", () => new Response("<html>", { status: 500 })],
    ["a connection that fails", () => Response.error()],
  ])("leaves the fields as entered and lets the member save after %s", async (_name, answer) => {
    use({ fetchBookmarkMetadata: () => answer() });
    const dialog = await openNew();
    await type("Title", "Typed");

    await enterUrl(DOCS);
    await waitFor(() => {
      expect(within(dialog).queryByRole("status", { name: SPINNER })).toBeNull();
    });

    expect(titleField().value).toBe("Typed");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/could not/i)).toBeNull();
    await save(dialog);
    expect(created).toEqual([{ url: DOCS, title: "Typed" }]);
  });

  it("reads again when the same address is left after a failed read", async () => {
    use({ fetchBookmarkMetadata: () => problem(502, "upstream_failed", "req-1") });
    const dialog = await openNew();
    await enterUrl(DOCS);
    await waitFor(() => {
      expect(within(dialog).queryByRole("status", { name: SPINNER })).toBeNull();
    });

    use();
    await leaveUrlField();

    await waitFor(() => {
      expect(titleField().value).toBe("Docs title");
    });
  });

  it("shows the text of a page as text", async () => {
    const markup = "<img src=x onerror=alert(1)>";
    use({ fetchBookmarkMetadata: () => json(page({ title: markup, description: "<script>alert(1)</script>" })) });
    const dialog = await openNew();

    await enterUrl(DOCS);
    await waitFor(() => {
      expect(titleField().value).toBe(markup);
    });
    await press(within(dialog).getByRole("button", { name: "More" }));

    expect(screen.getByLabelText<HTMLTextAreaElement>("Description").value).toBe("<script>alert(1)</script>");
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.querySelector("script")).toBeNull();
  });

  it("clears the message of an empty title once the page gave one", async () => {
    const dialog = await openNew();
    await type("URL", DOCS);
    use({ fetchBookmarkMetadata: () => json(page()) });
    await press(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Enter a title.")).toBeTruthy();

    await leaveUrlField();

    await waitFor(() => {
      expect(titleField().value).toBe("Docs title");
    });
    expect(within(dialog).queryByText("Enter a title.")).toBeNull();
  });

  it("closes without asking when the prefill is all that changed", async () => {
    const dialog = await openNew(`?new=1&url=${encodeURIComponent(DOCS)}`);
    await waitFor(() => {
      expect(titleField().value).toBe("Docs title");
    });

    await press(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New bookmark" })).toBeNull();
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks before closing once the member typed over the prefill", async () => {
    const dialog = await openNew(`?new=1&url=${encodeURIComponent(DOCS)}`);
    await waitFor(() => {
      expect(titleField().value).toBe("Docs title");
    });

    await type("Title", "Typed over it");
    await press(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(await screen.findByRole("alertdialog", { name: "Discard your changes?" })).toBeTruthy();
  });

  it("asks for nothing when the address of a bookmark that is changed is left as it is", async () => {
    const id = CREATED.id;
    use({}, { fixtures: { getBookmark: CREATED, listBookmarks: { items: [], nextCursor: null, total: 0 } } });
    window.history.replaceState(null, "", `/bookmarks?bookmark=${id}`);
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    const dialog = await screen.findByRole("dialog", { name: "Edit bookmark" });
    await waitFor(() => {
      expect(within(dialog).getByLabelText<HTMLInputElement>("URL").value).toBe(CREATED.url);
    });

    await leaveUrlField();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(asked).toEqual([]);
    expect(titleField().value).toBe("Example docs");
  });
});
