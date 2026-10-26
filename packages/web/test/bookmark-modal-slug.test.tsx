import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The slug and forwarding fields of the bookmark modal (doc 03 section 4, fields 3 and 4, doc 02 section 6.1) against a stubbed
// transport. The failure scenarios are a slug that is sent as typed (upper case, around spaces) or outside the grammar, a
// forwarding flag that is on without a slug or left on when the slug is cleared, an availability answer that is shown for
// an earlier slug, a check that is still running or has failed holding the save back, a slug the API refused that is raised
// as a toast instead of at the field, and an address that is shown for a slug that is not valid or is copied without saying so.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Availability = ComponentTypes["schemas"]["SlugAvailability"];
type Transport = (request: Request) => Promise<Response>;

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const BOOKMARK_ID = "0192f3a0-aaaa-7000-8000-000000000001";
const ORIGIN = "http://localhost:3000";

const BOOKMARK: Bookmark = {
  id: BOOKMARK_ID,
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

const SLUGGED: Bookmark = { ...BOOKMARK, slug: "docs", forwarding: true };

const FREE: Availability = { status: "available", othersUseCount: 0 };

interface Answers {
  readonly availability?: (request: Request) => Promise<Response> | Response;
  readonly createBookmark?: () => Response;
  readonly updateBookmark?: () => Response;
  readonly bookmark?: Bookmark;
}

interface Server {
  readonly posts: unknown[];
  readonly patches: { readonly ifMatch: string | null; readonly body: unknown }[];
  /** The `slug` and `bookmarkId` of every availability request, in the order they came. */
  readonly checks: { readonly slug: string | null; readonly bookmarkId: string | null }[];
}

function stubServer(answers: Answers = {}): Server {
  const posts: unknown[] = [];
  const patches: Server["patches"] = [];
  const checks: Server["checks"] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) =>
      signedIn(request, async (other) => {
        const url = new URL(other.url);
        if (url.pathname === "/api/v1/slugs/availability") {
          checks.push({ slug: url.searchParams.get("slug"), bookmarkId: url.searchParams.get("bookmarkId") });
          return answers.availability?.(other) ?? json(FREE);
        }
        if (url.pathname === "/api/v1/folders" || url.pathname === "/api/v1/tags" || (url.pathname === "/api/v1/bookmarks" && other.method === "GET")) {
          return json({ items: [], nextCursor: null, total: 0 });
        }
        if (url.pathname === "/api/v1/bookmarks" && other.method === "POST") {
          posts.push(JSON.parse(await other.clone().text()) as unknown);
          return answers.createBookmark?.() ?? json(BOOKMARK, { status: 201 });
        }
        if (url.pathname === `/api/v1/bookmarks/${BOOKMARK_ID}` && other.method === "GET") {
          return json(answers.bookmark ?? BOOKMARK);
        }
        if (url.pathname === `/api/v1/bookmarks/${BOOKMARK_ID}` && other.method === "PATCH") {
          patches.push({ ifMatch: other.headers.get("If-Match"), body: JSON.parse(await other.clone().text()) as unknown });
          return answers.updateBookmark?.() ?? json({ ...BOOKMARK, version: 4 });
        }
        return problem(404, "not_found", "req-404");
      }),
    ),
  );
  return { posts, patches, checks };
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
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

async function openApp(path: string): Promise<HTMLElement> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByLabelText("URL");
  return screen.findByRole("dialog", { name: /^(New|Edit) bookmark$/ });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function typeInto(input: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    await Promise.resolve();
  });
}

async function fill(dialog: HTMLElement): Promise<void> {
  await typeInto(within(dialog).getByLabelText("URL"), "https://example.com/docs");
  await typeInto(within(dialog).getByLabelText("Title"), "Example docs");
}

function slugField(dialog: HTMLElement): HTMLInputElement {
  return within(dialog).getByLabelText<HTMLInputElement>("Slug");
}

function forwardingSwitch(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole("switch", { name: "Forwarding" });
}

async function save(dialog: HTMLElement): Promise<void> {
  await press(within(dialog).getByRole("button", { name: "Save", hidden: true }));
}

function modal(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: /^(New|Edit) bookmark$/ });
}

describe("the slug and forwarding fields of a new bookmark", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("starts with no slug, the forwarding switch off and disabled with its reason, and sends neither", async () => {
    const server = stubServer();
    const dialog = await openApp("/?new=1");

    expect(slugField(dialog).value).toBe("");
    expect(within(dialog).getByText("/go/")).toBeTruthy();
    expect(forwardingSwitch(dialog).getAttribute("aria-checked")).toBe("false");
    expect(forwardingSwitch(dialog).hasAttribute("data-disabled")).toBe(true);
    expect(within(dialog).getByText("Give the bookmark a slug to turn forwarding on.")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Go address")).toBeNull();

    await fill(dialog);
    await save(dialog);
    await waitFor(() => {
      expect(server.posts).toHaveLength(1);
    });
    expect(server.posts[0]).toEqual({ url: "https://example.com/docs", title: "Example docs" });
    expect(server.checks).toEqual([]);
  });

  it("lower-cases and trims the slug as it is typed, turns forwarding on, checks it once and sends it", async () => {
    const server = stubServer();
    const dialog = await openApp("/?new=1");
    await fill(dialog);

    await typeInto(slugField(dialog), " Git");
    await typeInto(slugField(dialog), "GitHub ");

    expect(slugField(dialog).value).toBe("github");
    expect(forwardingSwitch(dialog).getAttribute("aria-checked")).toBe("true");
    expect(forwardingSwitch(dialog).hasAttribute("data-disabled")).toBe(false);
    expect(await within(dialog).findByText("This slug is free.")).toBeTruthy();
    expect(server.checks).toEqual([{ slug: "github", bookmarkId: null }]);
    expect(within(dialog).getByLabelText<HTMLInputElement>("Go address").value).toBe(`${ORIGIN}/go/github`);

    await save(dialog);
    await waitFor(() => {
      expect(modal()).toBeNull();
    });
    expect(server.posts).toEqual([{ url: "https://example.com/docs", title: "Example docs", slug: "github", forwarding: true }]);
  });

  it("sends the slug with forwarding off when the member turned it off", async () => {
    const server = stubServer();
    const dialog = await openApp("/?new=1");
    await fill(dialog);
    await typeInto(slugField(dialog), "gh");

    await press(forwardingSwitch(dialog));
    await save(dialog);

    await waitFor(() => {
      expect(server.posts).toHaveLength(1);
    });
    expect(server.posts[0]).toEqual({ url: "https://example.com/docs", title: "Example docs", slug: "gh", forwarding: false });
  });

  it("turns forwarding off and disables it again when the slug is emptied", async () => {
    stubServer();
    const dialog = await openApp("/?new=1");
    await typeInto(slugField(dialog), "gh");
    expect(forwardingSwitch(dialog).getAttribute("aria-checked")).toBe("true");

    await typeInto(slugField(dialog), "");

    expect(forwardingSwitch(dialog).getAttribute("aria-checked")).toBe("false");
    expect(forwardingSwitch(dialog).hasAttribute("data-disabled")).toBe(true);
    expect(within(dialog).queryByLabelText("Go address")).toBeNull();
  });

  it("explains the grammar at once for a slug outside it, asks nothing, shows no address and does not send it", async () => {
    const server = stubServer();
    const dialog = await openApp("/?new=1");
    await fill(dialog);

    await typeInto(slugField(dialog), "-docs");

    const explanation = "Use 1 to 64 lowercase letters, digits and hyphens, and do not start with a hyphen.";
    expect(within(dialog).getByText(explanation)).toBeTruthy();
    expect(within(dialog).queryByLabelText("Go address")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
    });
    expect(server.checks).toEqual([]);

    await save(dialog);
    expect(within(dialog).getByText(explanation)).toBeTruthy();
    expect(server.posts).toEqual([]);

    await typeInto(slugField(dialog), "a b");
    expect(within(dialog).getByText(explanation)).toBeTruthy();
    await typeInto(slugField(dialog), "ab");
    expect(within(dialog).queryByText(explanation)).toBeNull();
  });

  it("prefills the slug from the address, normalised, with forwarding on", async () => {
    const server = stubServer();
    const dialog = await openApp("/?new=1&slug=Mail");

    expect(slugField(dialog).value).toBe("mail");
    expect(forwardingSwitch(dialog).getAttribute("aria-checked")).toBe("true");
    await fill(dialog);
    await save(dialog);

    await waitFor(() => {
      expect(server.posts).toHaveLength(1);
    });
    expect(server.posts[0]).toEqual({ url: "https://example.com/docs", title: "Example docs", slug: "mail", forwarding: true });
  });

  it("marks the slug and the address as text that is not translated", async () => {
    stubServer();
    const dialog = await openApp("/?new=1&slug=mail&url=https%3A%2F%2Fexample.com%2F");

    expect(slugField(dialog).getAttribute("translate")).toBe("no");
    expect(within(dialog).getByText("/go/").getAttribute("translate")).toBe("no");
    expect(within(dialog).getByLabelText("Go address").getAttribute("translate")).toBe("no");
    expect(within(dialog).getByLabelText("URL").getAttribute("translate")).toBe("no");
  });
});

describe("the availability of a slug", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("says that a slug the member already uses is taken and shows no address for it", async () => {
    stubServer({ availability: () => json({ status: "taken_by_me", othersUseCount: 0 }) });
    const dialog = await openApp("/?new=1&slug=mail");

    expect(await within(dialog).findByText("You already use this slug on another bookmark. Choose a different one.")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Go address")).toBeNull();
  });

  it("tells how many other bookmarks have the slug without saying whose", async () => {
    stubServer({ availability: () => json({ status: "available", othersUseCount: 2 }) });
    const dialog = await openApp("/?new=1&slug=mail");

    expect(await within(dialog).findByText("2 other bookmarks in this workspace have this slug too. In go, yours comes first unless you have remembered another choice for this slug.")).toBeTruthy();
    expect(within(dialog).getByLabelText("Go address")).toBeTruthy();
  });

  it("names the bookmark being changed, so its own slug is free", async () => {
    const server = stubServer({ bookmark: SLUGGED });
    const dialog = await openApp(`/?bookmark=${BOOKMARK_ID}`);

    expect(slugField(dialog).value).toBe("docs");
    expect(await within(dialog).findByText("This slug is free.")).toBeTruthy();
    expect(server.checks).toEqual([{ slug: "docs", bookmarkId: BOOKMARK_ID }]);
  });

  it("shows the answer only for the slug it was asked about", async () => {
    stubServer({
      availability: (request) =>
        new URL(request.url).searchParams.get("slug") === "mail" ? json({ status: "taken_by_me", othersUseCount: 0 }) : json(FREE),
    });
    const dialog = await openApp("/?new=1&slug=mail");
    await within(dialog).findByText("You already use this slug on another bookmark. Choose a different one.");

    await typeInto(slugField(dialog), "mails");

    expect(within(dialog).queryByText("You already use this slug on another bookmark. Choose a different one.")).toBeNull();
    expect(await within(dialog).findByText("This slug is free.")).toBeTruthy();
  });

  it("does not hold the save back while the check is running", async () => {
    const server = stubServer({ availability: () => new Promise<Response>(() => undefined) });
    const dialog = await openApp("/?new=1&slug=mail");
    await fill(dialog);
    await waitFor(() => {
      expect(server.checks).toHaveLength(1);
    });
    expect(within(dialog).getByRole("status", { name: "Checking the slug" })).toBeTruthy();

    await save(dialog);

    await waitFor(() => {
      expect(server.posts).toHaveLength(1);
    });
    expect(server.posts[0]).toEqual({ url: "https://example.com/docs", title: "Example docs", slug: "mail", forwarding: true });
  });

  it("says the check failed, does not hold the save back and does not call the slug free", async () => {
    const server = stubServer({ availability: () => problem(503, "unavailable", "req-503") });
    const dialog = await openApp("/?new=1&slug=mail");
    await fill(dialog);

    expect(await within(dialog).findByText("We could not check whether this slug is free. You can still save.")).toBeTruthy();
    expect(within(dialog).queryByText("This slug is free.")).toBeNull();
    expect(within(dialog).queryByRole("status", { name: "Checking the slug" })).toBeNull();
    await save(dialog);

    await waitFor(() => {
      expect(server.posts).toHaveLength(1);
    });
  });
});

describe("a slug the API refuses on save", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is told at the field, keeps the modal and what was typed open and raises no toast", async () => {
    const server = stubServer({
      createBookmark: () =>
        json(
          { type: "https://slugbase.app/problems/slug_taken", title: "slug_taken", status: 409, code: "slug_taken", detail: "x", requestId: "req-409", errors: [{ path: "slug", code: "slug_taken" }] },
          { status: 409, contentType: "application/problem+json" },
        ),
    });
    const dialog = await openApp("/?new=1&slug=mail");
    await fill(dialog);

    await save(dialog);

    expect(await within(dialog).findByText("You already use this slug on another bookmark. Choose a different one.")).toBeTruthy();
    expect(server.posts).toHaveLength(1);
    expect(modal()).not.toBeNull();
    expect(slugField(dialog).value).toBe("mail");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Title").value).toBe("Example docs");
    expect(screen.queryByText("The change was not saved")).toBeNull();

    await typeInto(slugField(dialog), "mail2");
    expect(within(dialog).queryByText("You already use this slug on another bookmark. Choose a different one.")).toBeNull();
  });

  it("is told at the field when the API finds it outside the grammar", async () => {
    stubServer({
      createBookmark: () =>
        json(
          { type: "https://slugbase.app/problems/validation_failed", title: "validation_failed", status: 422, code: "validation_failed", detail: "x", requestId: "req-422", errors: [{ path: "slug", code: "invalid_format" }] },
          { status: 422, contentType: "application/problem+json" },
        ),
    });
    const dialog = await openApp("/?new=1&slug=mail");
    await fill(dialog);

    await save(dialog);

    expect(await within(dialog).findByText("Use 1 to 64 lowercase letters, digits and hyphens, and do not start with a hyphen.")).toBeTruthy();
    expect(modal()).not.toBeNull();
  });
});

describe("the slug and forwarding of a bookmark that is changed", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("sends neither when they are not changed", async () => {
    const server = stubServer({ bookmark: SLUGGED });
    const dialog = await openApp(`/?bookmark=${BOOKMARK_ID}`);
    await typeInto(within(dialog).getByLabelText("Title"), "Renamed");

    await save(dialog);

    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    expect(server.patches[0]).toEqual({ ifMatch: '"3"', body: { title: "Renamed" } });
  });

  it("sends a new slug and leaves forwarding as it is", async () => {
    const server = stubServer({ bookmark: SLUGGED });
    const dialog = await openApp(`/?bookmark=${BOOKMARK_ID}`);

    await typeInto(slugField(dialog), "Manual");
    await save(dialog);

    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    expect(server.patches[0]).toEqual({ ifMatch: '"3"', body: { slug: "manual" } });
  });

  it("sends forwarding alone when it is turned off, which keeps the slug", async () => {
    const server = stubServer({ bookmark: SLUGGED });
    const dialog = await openApp(`/?bookmark=${BOOKMARK_ID}`);

    await press(forwardingSwitch(dialog));
    await save(dialog);

    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    expect(server.patches[0]).toEqual({ ifMatch: '"3"', body: { forwarding: false } });
  });

  it("clears the slug together with forwarding, so the API does not refuse a slugless bookmark that forwards", async () => {
    const server = stubServer({ bookmark: SLUGGED });
    const dialog = await openApp(`/?bookmark=${BOOKMARK_ID}`);

    await typeInto(slugField(dialog), "");
    await save(dialog);

    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    expect(server.patches[0]).toEqual({ ifMatch: '"3"', body: { slug: null, forwarding: false } });
  });

  it("gives a bookmark without a slug one, with forwarding on", async () => {
    const server = stubServer();
    const dialog = await openApp(`/?bookmark=${BOOKMARK_ID}`);

    await typeInto(slugField(dialog), "docs");
    await save(dialog);

    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    expect(server.patches[0]).toEqual({ ifMatch: '"3"', body: { slug: "docs", forwarding: true } });
  });

  it("asks before closing over a changed slug", async () => {
    stubServer({ bookmark: SLUGGED });
    const dialog = await openApp(`/?bookmark=${BOOKMARK_ID}`);

    await typeInto(slugField(dialog), "other");
    await press(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText("Discard your changes?")).toBeTruthy();
  });
});

describe("the address of a slug", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is copied with a toast", async () => {
    stubServer();
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    const dialog = await openApp("/?new=1&slug=mail");

    await press(await within(dialog).findByRole("button", { name: "Copy go address" }));

    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}/go/mail`);
    expect(await screen.findByText("Address copied to the clipboard.")).toBeTruthy();
  });

  it("claims no copy when the clipboard refuses", async () => {
    stubServer();
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
    });
    const dialog = await openApp("/?new=1&slug=mail");

    await press(await within(dialog).findByRole("button", { name: "Copy go address" }));

    expect(screen.queryByText("Address copied to the clipboard.")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Copy go address" })).toBeTruthy();
  });
});

describe("the slug and forwarding fields in German", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("are in German, the explanation of a switch that cannot be turned on included", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer();
    window.history.replaceState(null, "", "/?new=1");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    const dialog = await screen.findByRole("dialog", { name: "Neues Lesezeichen" });

    expect(within(dialog).getByLabelText("Slug")).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "Weiterleitung" })).toBeTruthy();
    expect(within(dialog).getByText("Gib dem Lesezeichen einen Slug, um die Weiterleitung einzuschalten.")).toBeTruthy();
  });
});
