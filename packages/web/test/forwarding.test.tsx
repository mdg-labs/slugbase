import type { ComponentTypes } from "@slugbase/contracts";
import { toastManager } from "@slugbase/ui";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { CONFIG_BODY, allowSlowRender, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The Forwarding page (doc 03 section 8, doc 02 section 6.4) through the app's own API client, against a stubbed transport that
// keeps the member's bookmarks and remembered choices the way the API does: a bookmark list filtered by `hasSlug` and `scope`, a
// change against the version in If-Match (412 when it is stale), forwarding that needs a slug, a remembered choice that goes with
// a bookmark that stops forwarding, and POST /go/choose, which would store a choice and also count a use of its bookmark. The failure scenarios are a list that failed
// shown as "no slugs" or "nothing remembered", a Switch that waits for the server instead of showing its change, a refused change
// that stays on screen, a change sent without the version it was made against, a removal that asks first, an undo that sends anything
// to the server or a removal that is never sent, and a shortcut or link that does not reach the page.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type GoPreference = ComponentTypes["schemas"]["GoPreference"];
type Transport = (request: Request) => Promise<Response>;

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const BOOKMARKS = "/api/v1/bookmarks";
const PREFERENCES = "/api/v1/me/go-preferences";
const CHOOSE = "/api/v1/go/choose";

function bookmarkId(n: number): string {
  return `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`;
}

function bookmarkOf(n: number, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: bookmarkId(n),
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
    version: 1,
    createdAt: `2026-10-01T08:${String(n).padStart(2, "0")}:00.000Z`,
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...overrides,
  };
}

function choiceOf(slug: string, n: number, owner: GoPreference["owner"] = null): GoPreference {
  return { slug, bookmarkId: bookmarkId(n), title: `Bookmark ${String(n)}`, host: `site${String(n)}.example.com`, owner };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly ifMatch: string | null;
  readonly keepalive: boolean;
  readonly body: unknown;
}

interface Answers {
  /** Replaces the answer to a change of a bookmark; undefined falls through to the stub's own. */
  readonly patch?: (call: Call) => Promise<Response | undefined> | Response | undefined;
  /** Replaces the answer to a read of the bookmark list. */
  readonly bookmarks?: (call: Call) => Response | undefined;
  /** Replaces the answer to a read of the remembered choices. */
  readonly preferences?: (call: Call) => Response | undefined;
  /** Holds the answer to every read of the remembered choices until it settles. */
  readonly holdPreferences?: Promise<void>;
  /** The origin `/api/config` reports; the test page itself is served from another. */
  readonly origin?: string;
  /** The status the removal of a choice is refused with. */
  readonly refuseDelete?: number;
}

interface World {
  readonly bookmarks: Bookmark[];
  readonly choices: GoPreference[];
}

interface Server {
  readonly calls: Call[];
  readonly world: World;
  readonly to: (method: string, path: string) => Call[];
}

function stubServer(world: World, answers: Answers = {}): Server {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) =>
      answers.origin !== undefined && new URL(request.url).pathname === "/api/config"
        ? Promise.resolve(json({ ...CONFIG_BODY, origin: answers.origin }))
        : signedIn(request, async (other) => {
        const url = new URL(other.url);
        const text = other.method === "GET" || other.method === "DELETE" ? "" : await other.clone().text();
        const body: unknown = text === "" ? undefined : JSON.parse(text);
        const call: Call = { method: other.method, path: url.pathname, params: url.searchParams, ifMatch: other.headers.get("If-Match"), keepalive: other.keepalive, body };
        if (url.pathname === "/api/v1/folders" || url.pathname === "/api/v1/tags") {
          return json({ items: [], nextCursor: null, total: 0 });
        }
        calls.push(call);
        if (url.pathname === BOOKMARKS && other.method === "GET") {
          const custom = answers.bookmarks?.(call);
          if (custom !== undefined) {
            return custom;
          }
          const items = world.bookmarks
            .filter((candidate) => (url.searchParams.get("hasSlug") === "true" ? candidate.slug !== null : true))
            .filter((candidate) => (url.searchParams.get("scope") === "mine" ? candidate.ownerId === OWNER : true))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          return json({ items, nextCursor: null, total: items.length });
        }
        if (url.pathname.startsWith(`${BOOKMARKS}/`) && other.method === "PATCH") {
          const custom = await answers.patch?.(call);
          if (custom !== undefined) {
            return custom;
          }
          const target = world.bookmarks.find((candidate) => url.pathname === `${BOOKMARKS}/${candidate.id}`);
          if (target === undefined) {
            return problem(404, "not_found", "req-404");
          }
          if (call.ifMatch !== `"${String(target.version)}"`) {
            return problem(412, "precondition_failed", "req-412");
          }
          const patch = body as { forwarding?: boolean };
          if (patch.forwarding !== undefined) {
            target.forwarding = patch.forwarding;
            if (!patch.forwarding) {
              world.choices.splice(0, world.choices.length, ...world.choices.filter((choice) => choice.bookmarkId !== target.id));
            }
          }
          target.version += 1;
          return json(target, { headers: { ETag: `"${String(target.version)}"` } });
        }
        if (url.pathname === PREFERENCES && other.method === "GET") {
          await answers.holdPreferences;
          const custom = answers.preferences?.(call);
          return custom ?? json({ items: world.choices, nextCursor: null });
        }
        if (url.pathname.startsWith(`${PREFERENCES}/`) && other.method === "DELETE") {
          if (answers.refuseDelete !== undefined) {
            return problem(answers.refuseDelete, answers.refuseDelete === 404 ? "not_found" : "internal_error", "req-refused");
          }
          const slug = decodeURIComponent(url.pathname.slice(PREFERENCES.length + 1));
          const at = world.choices.findIndex((choice) => choice.slug === slug);
          if (at < 0) {
            return problem(404, "not_found", "req-404");
          }
          world.choices.splice(at, 1);
          return new Response(null, { status: 204 });
        }
        if (url.pathname === CHOOSE && other.method === "POST") {
          const chosen = body as { slug: string; bookmarkId: string; remember?: boolean };
          const target = world.bookmarks.find((candidate) => candidate.id === chosen.bookmarkId);
          if (target === undefined) {
            return problem(404, "slug_not_found", "req-404");
          }
          if (chosen.remember === true) {
            world.choices.push(choiceOf(chosen.slug, world.bookmarks.indexOf(target) + 1));
          }
          return json({ url: target.url });
        }
        return problem(404, "not_found", "req-404");
      }),
    ),
  );
  return { calls, world, to: (method, path) => calls.filter((call) => call.method === method && call.path === path) };
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

async function key(init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(window, init);
    await Promise.resolve();
  });
}

/** The row of a slug in the table of one section. */
function rowOf(table: string, text: string): HTMLElement {
  const row = within(screen.getByRole("table", { name: table })).getByText(text).closest("tr");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

function slugSwitch(slug: string): HTMLElement {
  return screen.getByRole("switch", { name: `Forwarding for ${slug}` });
}

async function chooseAction(slug: string, action: string): Promise<void> {
  await press(screen.getByRole("button", { name: `Actions for ${slug}` }));
  await press(await screen.findByRole("menuitem", { name: action }));
}

function worldOf(): World {
  return {
    bookmarks: [
      bookmarkOf(1, { slug: "mail", forwarding: true, openCount: 12, lastOpenedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() }),
      bookmarkOf(2, { slug: "docs", forwarding: false }),
      bookmarkOf(3),
      bookmarkOf(4, { slug: "gh", forwarding: true, ownerId: "0192f3a0-bbbb-7000-8000-000000000002" }),
      bookmarkOf(5, { slug: "wiki", forwarding: true }),
    ],
    choices: [choiceOf("gh", 4, { accountId: "0192f3a0-bbbb-7000-8000-000000000002", displayName: "Grace Hopper" }), choiceOf("wiki", 5)],
  };
}

describe("reaching the page", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is the Forwarding link of the sidebar, and lists the member's own bookmarks that have a slug", async () => {
    const server = stubServer(worldOf());
    await openApp("/");

    await press(await screen.findByRole("link", { name: "Forwarding" }));

    await screen.findByRole("heading", { level: 1, name: "Forwarding" });
    expect(window.location.pathname).toBe("/forwarding");
    expect(screen.getByRole("link", { name: "Forwarding" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toBe("Forwarding");
    await screen.findByRole("table", { name: "Your slugs" });
    const [list] = server.to("GET", BOOKMARKS);
    expect(list?.params.get("hasSlug")).toBe("true");
    expect(list?.params.get("scope")).toBe("mine");
    const mail = rowOf("Your slugs", "/go/mail");
    expect(within(mail).getByText("site1.example.com")).toBeDefined();
    expect(within(mail).getByText("12")).toBeDefined();
    expect(within(mail).getByText("3 days ago")).toBeDefined();
    expect(slugSwitch("mail").getAttribute("aria-checked")).toBe("true");
    expect(slugSwitch("docs").getAttribute("aria-checked")).toBe("false");
    expect(within(rowOf("Your slugs", "/go/docs")).getByText("Never")).toBeDefined();
    expect(screen.queryByText("Bookmark 3")).toBeNull();
    // Another member's bookmark with a slug is not one of the member's own slugs.
    expect(within(screen.getByRole("table", { name: "Your slugs" })).queryByText("/go/gh")).toBeNull();
  });

  it("lists the remembered choices with the bookmark, its host and its owner", async () => {
    stubServer(worldOf());
    await openApp("/forwarding");

    await screen.findByRole("table", { name: "Remembered choices" });

    const gh = rowOf("Remembered choices", "/go/gh");
    expect(within(gh).getByText("Bookmark 4")).toBeDefined();
    expect(within(gh).getByText("site4.example.com")).toBeDefined();
    expect(within(gh).getByText("Grace Hopper")).toBeDefined();
    expect(within(rowOf("Remembered choices", "/go/wiki")).getByText("You")).toBeDefined();
  });

  it("goes there with G then W from another page, and says so in the shortcut sheet", async () => {
    stubServer(worldOf());
    await openApp("/");
    await screen.findByRole("heading", { level: 1 });

    await key({ key: "g" });
    await key({ key: "w" });

    await screen.findByRole("heading", { level: 1, name: "Forwarding" });
    expect(window.location.pathname).toBe("/forwarding");

    await key({ key: "?", shiftKey: true });
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).getByText("Go to Forwarding")).toBeDefined();
  });

  it("is in German with the account's language", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer(worldOf());
    await openApp("/forwarding");

    await screen.findByRole("heading", { level: 1, name: "Weiterleitung" });
    await screen.findByRole("table", { name: "Deine Slugs" });
    expect(screen.getByRole("switch", { name: "Weiterleitung für mail" })).toBeDefined();
    expect(screen.getByRole("table", { name: "Gemerkte Auswahl" })).toBeDefined();
  });
});

describe("the forwarding switch", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the change before the server has answered, and saves it against the version the list holds", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = stubServer(worldOf(), {
      patch: async () => {
        await held;
        return undefined;
      },
    });
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Your slugs" });

    await press(slugSwitch("mail"));

    await waitFor(() => {
      expect(slugSwitch("mail").getAttribute("aria-checked")).toBe("false");
    });
    await waitFor(() => {
      expect(server.to("PATCH", `${BOOKMARKS}/${bookmarkId(1)}`)).toHaveLength(1);
    });
    const [patch] = server.to("PATCH", `${BOOKMARKS}/${bookmarkId(1)}`);
    expect(patch?.body).toEqual({ forwarding: false });
    expect(patch?.ifMatch).toBe('"1"');
    await act(async () => {
      release();
      await held;
    });
    await waitFor(() => {
      expect(server.world.bookmarks[0]?.forwarding).toBe(false);
    });
    expect(slugSwitch("mail").getAttribute("aria-checked")).toBe("false");
  });

  it("turns forwarding on for a slug that is off", async () => {
    const server = stubServer(worldOf());
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Your slugs" });

    await press(slugSwitch("docs"));

    await waitFor(() => {
      expect(server.world.bookmarks[1]?.forwarding).toBe(true);
    });
    expect(slugSwitch("docs").getAttribute("aria-checked")).toBe("true");
    expect(server.to("PATCH", `${BOOKMARKS}/${bookmarkId(2)}`)[0]?.body).toEqual({ forwarding: true });
  });

  it("puts the switch back and says so in a toast when the server refuses", async () => {
    const server = stubServer(worldOf(), { patch: () => problem(500, "internal_error", "req-500") });
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Your slugs" });

    await press(slugSwitch("mail"));

    expect((await screen.findAllByText("Forwarding could not be turned off. It is on again.")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(slugSwitch("mail").getAttribute("aria-checked")).toBe("true");
    });
    expect(server.world.bookmarks[0]?.forwarding).toBe(true);
  });

  it("says the bookmark changed elsewhere when its version is stale, and does not overwrite it", async () => {
    const world = worldOf();
    const server = stubServer(world);
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Your slugs" });
    // Another session changed the bookmark after this page read it.
    const mail = world.bookmarks[0];
    if (mail !== undefined) {
      mail.version = 2;
    }

    await press(slugSwitch("mail"));

    expect((await screen.findAllByText("This bookmark was changed elsewhere, so forwarding was not changed. The list is up to date again.")).length).toBeGreaterThan(0);
    expect(server.world.bookmarks[0]?.forwarding).toBe(true);
    await waitFor(() => {
      expect(slugSwitch("mail").getAttribute("aria-checked")).toBe("true");
    });
  });
});

describe("the actions of a row", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("turns forwarding off from the menu, and offers it only where forwarding is on", async () => {
    const server = stubServer(worldOf());
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Your slugs" });

    await press(screen.getByRole("button", { name: "Actions for docs" }));
    expect((await screen.findByRole("menuitem", { name: "Turn off forwarding" })).getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await Promise.resolve();
    });

    await chooseAction("mail", "Turn off forwarding");

    await waitFor(() => {
      expect(server.world.bookmarks[0]?.forwarding).toBe(false);
    });
    expect(server.to("PATCH", `${BOOKMARKS}/${bookmarkId(1)}`)[0]?.body).toEqual({ forwarding: false });
    expect(slugSwitch("mail").getAttribute("aria-checked")).toBe("false");
  });

  it("opens the bookmark in the modal from Edit", async () => {
    stubServer(worldOf());
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Your slugs" });

    await chooseAction("mail", "Edit");

    await screen.findByRole("dialog", { name: "Edit bookmark" });
    expect(window.location.pathname).toBe("/forwarding");
    expect(window.location.search).toContain(bookmarkId(1));
  });

  it("copies the address on the origin of the app, and claims nothing when the clipboard refuses", async () => {
    stubServer(worldOf());
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Your slugs" });

    await chooseAction("mail", "Copy address");

    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/go/mail");
    expect((await screen.findAllByText("Copied http://localhost:3000/go/mail")).length).toBeGreaterThan(0);

    await chooseAction("docs", "Copy address");

    expect((await screen.findAllByText("The address could not be copied. Select it and copy it by hand.")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Copied http://localhost:3000/go/docs")).toBeNull();
    Reflect.deleteProperty(window.navigator, "clipboard");
  });

  it("says the address could not be copied on a page without a clipboard", async () => {
    stubServer(worldOf());
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: undefined });
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Your slugs" });

    await chooseAction("mail", "Copy address");

    expect((await screen.findAllByText("The address could not be copied. Select it and copy it by hand.")).length).toBeGreaterThan(0);
    Reflect.deleteProperty(window.navigator, "clipboard");
  });
});

/** Lets the toast that offers the undo of a removal run out, the way its timer would. */
async function closeLastToast(add: { readonly mock: { readonly results: readonly { readonly value: unknown }[] } }): Promise<void> {
  const id = add.mock.results.at(-1)?.value;
  expect(typeof id).toBe("string");
  await act(async () => {
    toastManager.close(id as string);
    await Promise.resolve();
  });
}

function choicesTable(): HTMLElement {
  return screen.getByRole("table", { name: "Remembered choices" });
}

describe("remembered choices", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("takes a choice off the list at once without asking, and the server forgets it when the toast closes", async () => {
    const server = stubServer(worldOf());
    const add = vi.spyOn(toastManager, "add");
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Remembered choices" });

    await press(screen.getByRole("button", { name: "Remove the remembered choice for wiki" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(within(choicesTable()).queryByText("/go/wiki")).toBeNull();
    await screen.findByRole("button", { name: "Undo" });
    expect((await screen.findAllByText("Forgot your choice for wiki.")).length).toBeGreaterThan(0);
    expect(server.to("DELETE", `${PREFERENCES}/wiki`)).toHaveLength(0);

    await closeLastToast(add);

    await waitFor(() => {
      expect(server.to("DELETE", `${PREFERENCES}/wiki`)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(server.to("GET", PREFERENCES).length).toBeGreaterThan(1);
    });
    expect(within(choicesTable()).queryByText("/go/wiki")).toBeNull();
    expect(rowOf("Remembered choices", "/go/gh")).toBeDefined();
  });

  it("puts the choice back with Undo and sends nothing to the server, so no use of the bookmark is counted", async () => {
    const server = stubServer(worldOf());
    const add = vi.spyOn(toastManager, "add");
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Remembered choices" });
    await press(screen.getByRole("button", { name: "Remove the remembered choice for wiki" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    const requestsBefore = server.calls.length;

    await press(undo);

    await waitFor(() => {
      expect(rowOf("Remembered choices", "/go/wiki")).toBeDefined();
    });
    expect((await screen.findAllByText("Remembered your choice for wiki again.")).length).toBeGreaterThan(0);
    await closeLastToast(add);
    expect(server.to("POST", CHOOSE)).toHaveLength(0);
    expect(server.to("DELETE", `${PREFERENCES}/wiki`)).toHaveLength(0);
    expect(server.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
    expect(server.calls.length).toBe(requestsBefore);
    expect(server.world.choices.map((choice) => choice.slug)).toContain("wiki");
  });

  it("forgets the choice at once when the page is hidden before the toast closes", async () => {
    const server = stubServer(worldOf());
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Remembered choices" });
    await press(screen.getByRole("button", { name: "Remove the remembered choice for wiki" }));
    await screen.findByRole("button", { name: "Undo" });
    expect(server.to("DELETE", `${PREFERENCES}/wiki`)).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(server.to("DELETE", `${PREFERENCES}/wiki`)).toHaveLength(1);
    });
    expect(server.to("DELETE", `${PREFERENCES}/wiki`)[0]?.keepalive, "the removal outlives the page").toBe(true);
  });

  it("forgets the choice at once when the member leaves the page before the toast closes", async () => {
    const server = stubServer(worldOf());
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Remembered choices" });
    await press(screen.getByRole("button", { name: "Remove the remembered choice for wiki" }));
    await screen.findByRole("button", { name: "Undo" });

    await press(screen.getByRole("link", { name: "Bookmarks" }));

    await waitFor(() => {
      expect(server.to("DELETE", `${PREFERENCES}/wiki`)).toHaveLength(1);
    });
    expect(server.to("POST", CHOOSE)).toHaveLength(0);
  });

  it("shows the choice again and says so when the server refuses to forget it", async () => {
    stubServer(worldOf(), { refuseDelete: 500 });
    const add = vi.spyOn(toastManager, "add");
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Remembered choices" });
    await press(screen.getByRole("button", { name: "Remove the remembered choice for wiki" }));
    await screen.findByRole("button", { name: "Undo" });

    await closeLastToast(add);

    expect((await screen.findAllByText("The remembered choice could not be removed.")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(rowOf("Remembered choices", "/go/wiki")).toBeDefined();
    });
  });

  it("drops a choice from the list when its bookmark stops forwarding", async () => {
    stubServer(worldOf());
    await openApp("/forwarding");
    await screen.findByRole("table", { name: "Remembered choices" });
    expect(rowOf("Remembered choices", "/go/wiki")).toBeDefined();

    await press(slugSwitch("wiki"));

    await waitFor(() => {
      expect(within(screen.getByRole("table", { name: "Remembered choices" })).queryByText("/go/wiki")).toBeNull();
    });
    expect(rowOf("Remembered choices", "/go/gh")).toBeDefined();
  });
});

describe("empty and failed sections", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("teaches in each section when it has nothing, and the slugs section offers New bookmark", async () => {
    stubServer({ bookmarks: [bookmarkOf(3)], choices: [] });
    await openApp("/forwarding");

    expect(await screen.findByRole("heading", { level: 3, name: "No slugs yet" })).toBeDefined();
    expect(screen.getByRole("heading", { level: 3, name: "Nothing remembered yet" })).toBeDefined();
    expect(screen.queryByRole("table", { name: "Your slugs" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Remembered choices" })).toBeNull();

    await press(within(screen.getByRole("main", { hidden: true })).getByRole("button", { name: "New bookmark" }));

    await screen.findByRole("dialog", { name: "New bookmark" });
  });

  it("shows a slugs list that failed as an error with a retry, never as no slugs", async () => {
    let failing = true;
    stubServer(worldOf(), { bookmarks: () => (failing ? problem(500, "internal_error", "req-500") : undefined) });
    await openApp("/forwarding");

    const banner = await screen.findByText("Your slugs could not be loaded.");
    expect(banner).toBeDefined();
    expect(screen.queryByRole("heading", { name: "No slugs yet" })).toBeNull();
    failing = false;

    await press(within(banner.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Try again" }));

    await screen.findByRole("table", { name: "Your slugs" });
    expect(screen.queryByText("Your slugs could not be loaded.")).toBeNull();
  });

  it("shows a remembered-choices list that failed as an error with a retry, never as nothing remembered", async () => {
    let failing = true;
    stubServer(worldOf(), { preferences: () => (failing ? problem(500, "internal_error", "req-500") : undefined) });
    await openApp("/forwarding");

    const banner = await screen.findByText("Your remembered choices could not be loaded.");
    expect(screen.queryByRole("heading", { name: "Nothing remembered yet" })).toBeNull();
    // The other section is not held back by it.
    expect(await screen.findByRole("table", { name: "Your slugs" })).toBeDefined();
    failing = false;

    await press(within(banner.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Try again" }));

    await screen.findByRole("table", { name: "Remembered choices" });
  });

  it("shows skeletons while the lists load", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer(worldOf(), { holdPreferences: held });
    await openApp("/forwarding");

    expect(await screen.findByRole("status", { name: "Loading your remembered choices" })).toBeDefined();
    await act(async () => {
      release();
      await held;
    });
    await screen.findByRole("table", { name: "Remembered choices" });
  });
});

describe("setting up the browser", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  const ORIGIN = "https://links.example.org";

  it("shows the search engine address on the configured origin and the keyword as values to copy", async () => {
    stubServer(worldOf(), { origin: ORIGIN });
    await openApp("/forwarding");

    const address = await screen.findByRole("textbox", { name: "Search engine address" });
    const keyword = screen.getByRole("textbox", { name: "Keyword" });

    expect((address as HTMLInputElement).value).toBe(`${ORIGIN}/go/%s`);
    expect((address as HTMLInputElement).readOnly).toBe(true);
    expect((keyword as HTMLInputElement).value).toBe("go");
    expect(window.location.origin).not.toBe(ORIGIN);
  });

  it("copies the address and the keyword", async () => {
    stubServer(worldOf(), { origin: ORIGIN });
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    await openApp("/forwarding");

    await press(await screen.findByRole("button", { name: "Copy the search engine address" }));
    await press(screen.getByRole("button", { name: "Copy the keyword" }));

    expect(writeText.mock.calls.map(([text]) => text)).toEqual([`${ORIGIN}/go/%s`, "go"]);
    Reflect.deleteProperty(window.navigator, "clipboard");
  });

  it("has a tab for each of Chrome, Firefox, Safari and Edge, whose steps name the address and the keyword", async () => {
    stubServer(worldOf(), { origin: ORIGIN });
    await openApp("/forwarding");
    const tabs = await screen.findAllByRole("tab");

    expect(tabs.map((tab) => tab.textContent)).toEqual(["Chrome", "Firefox", "Safari", "Edge"]);
    expect(screen.getByRole("tab", { name: "Chrome" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Chrome" }).textContent).toContain(`paste ${ORIGIN}/go/%s as the URL`);

    await press(screen.getByRole("tab", { name: "Firefox" }));
    expect(screen.getByRole("tabpanel", { name: "Firefox" }).textContent).toContain("Under Search Shortcuts, choose Add.");
    expect(screen.getByRole("tabpanel", { name: "Firefox" }).textContent).toContain(`paste ${ORIGIN}/go/%s as the URL and enter go as the alias`);

    await press(screen.getByRole("tab", { name: "Safari" }));
    expect(screen.getByRole("tabpanel", { name: "Safari" }).textContent).toContain("Safari has no setting for a custom search engine.");
    expect(screen.getByRole("tabpanel", { name: "Safari" }).textContent).toContain(`${ORIGIN}/go/%s`);

    await press(screen.getByRole("tab", { name: "Edge" }));
    expect(screen.getByRole("tabpanel", { name: "Edge" }).textContent).toContain("Address bar and search");
    expect(screen.getByRole("tabpanel", { name: "Edge" }).textContent).toContain(`${ORIGIN}/go/%s`);
  });

  it("tries one of the member's own forwarding slugs, skipping one that does not forward", async () => {
    const world: World = { bookmarks: [bookmarkOf(2, { slug: "docs", forwarding: false }), bookmarkOf(1, { slug: "mail", forwarding: true })], choices: [] };
    stubServer(world);
    await openApp("/forwarding");

    const link = await screen.findByRole("link", { name: "Test it: open go/mail" });

    expect(link.getAttribute("href")).toBe("/go/mail");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText(/Opens go\/mail in a new tab\./)).toBeDefined();
  });

  it("tries a sample address when the member has no slug that forwards", async () => {
    stubServer({ bookmarks: [bookmarkOf(2, { slug: "docs", forwarding: false })], choices: [] });
    await openApp("/forwarding");

    const link = await screen.findByRole("link", { name: "Test it: open go/sample" });

    expect(link.getAttribute("href")).toBe("/go/sample");
    expect(screen.getByText(/so this opens a sample address/)).toBeDefined();
  });

  it("still shows the section when the slugs could not be loaded, with the sample to try", async () => {
    stubServer(worldOf(), { bookmarks: () => problem(500, "internal_error", "req-500") });
    await openApp("/forwarding");

    expect(await screen.findByRole("heading", { level: 2, name: "Set up your browser" })).toBeDefined();
    expect((await screen.findByRole("link", { name: "Test it: open go/sample" })).getAttribute("href")).toBe("/go/sample");
  });

  it("is usable on a narrow screen and in German", async () => {
    stubMatchMedia(true);
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer(worldOf(), { origin: ORIGIN });
    await openApp("/forwarding");

    expect(await screen.findByRole("heading", { level: 2, name: "Browser einrichten" })).toBeDefined();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Adresse der Suchmaschine" }).value).toBe(`${ORIGIN}/go/%s`);
    await press(screen.getByRole("tab", { name: "Firefox" }));
    expect(screen.getByRole("tabpanel", { name: "Firefox" }).textContent).toContain("Wähle unter Suchkürzel Hinzufügen.");
    expect(screen.getByRole("link", { name: /^Ausprobieren: go\/.+ öffnen$/ })).toBeDefined();
  });
});
