import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// What the page shows while a request is still on its way, which the generated handlers cannot hold back: the skeleton
// cards while the first page is read, and a pin that is shown before the server answered and taken back when it
// refuses. The failure scenarios are a pin shown only once the server answered, a pin that stays on the card after the
// server refused it (and the read that follows cannot put it right), a second change sent against a version that is
// about to be replaced, and a wait shown as an empty list. The transport is stubbed.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];
type Transport = (request: Request) => Promise<Response>;

const LIST = "/api/v1/bookmarks";
const ID = "0192f3a0-aaaa-7000-8000-000000000001";

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

/** A response the test lets through when it chooses. */
function gate(): { readonly open: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open, release };
}

interface Patch {
  readonly ifMatch: string | null;
  readonly body: unknown;
}

interface Answers {
  readonly list?: () => Promise<Response> | Response;
  readonly patch?: () => Promise<Response> | Response;
}

/** A signed-in server whose bookmark list and bookmark update answer as `answers` say (the one bookmark, and the update it asks for, by default). */
function stubServer(answers: Answers = {}): { readonly patches: Patch[]; readonly lists: () => number } {
  const patches: Patch[] = [];
  let lists = 0;
  // What the server holds: a successful update changes it, so the list read afterwards agrees with the pin.
  let stored = BOOKMARK;
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) =>
      signedIn(request, async (other) => {
        const { pathname } = new URL(other.url);
        if (pathname === LIST && other.method === "GET") {
          lists += 1;
          return answers.list?.() ?? json({ items: [stored], nextCursor: null, total: 1 });
        }
        if (pathname === `${LIST}/${ID}` && other.method === "PATCH") {
          patches.push({ ifMatch: other.headers.get("If-Match"), body: JSON.parse(await other.clone().text()) as unknown });
          const answer = await (answers.patch?.() ?? json({ ...BOOKMARK, pinned: true, version: 4 }));
          if (answer.ok) {
            stored = { ...BOOKMARK, pinned: true, version: 4 };
          }
          return answer;
        }
        return problem(404, "not_found", "req-404");
      }),
    ),
  );
  return { patches, lists: () => lists };
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

async function openApp(): Promise<void> {
  window.history.replaceState(null, "", "/bookmarks");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function card(): Promise<HTMLElement> {
  const link = await screen.findByRole("link", { name: "Example docs" });
  return link.closest("[data-item-id]") as HTMLElement;
}

async function chooseAction(action: string): Promise<void> {
  await press(screen.getByRole("button", { name: "Actions for Example docs" }));
  await press(await screen.findByRole("menuitem", { name: action }));
}

describe("while the first page is being read", () => {
  it("shows skeleton cards, not an empty list, and then the cards", async () => {
    const answer = gate();
    stubServer({
      list: async () => {
        await answer.open;
        return json({ items: [BOOKMARK], nextCursor: null, total: 1 });
      },
    });
    await openApp();

    const wait = await screen.findByRole("status", { name: "Loading the bookmarks" });
    expect(wait.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("list", { name: "Bookmarks" })).toBeNull();
    expect(screen.queryByText("No bookmarks yet")).toBeNull();
    await act(async () => {
      answer.release();
      await Promise.resolve();
    });

    await card();
    expect(screen.queryByRole("status", { name: "Loading the bookmarks" })).toBeNull();
  });
});

describe("pinning", () => {
  it("shows the pin before the server answered, sends the version the list holds and keeps the pin", async () => {
    const answer = gate();
    const server = stubServer({
      patch: async () => {
        await answer.open;
        return json({ ...BOOKMARK, pinned: true, version: 4 });
      },
    });
    await openApp();
    expect(within(await card()).queryByRole("img", { name: "Pinned" })).toBeNull();

    await chooseAction("Pin");

    expect(await within(await card()).findByRole("img", { name: "Pinned" })).toBeDefined();
    await waitFor(() => {
      expect(server.patches).toHaveLength(1);
    });
    expect(server.patches[0]).toEqual({ ifMatch: '"3"', body: { pinned: true } });
    await act(async () => {
      answer.release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(server.lists()).toBeGreaterThan(1);
    });
    expect(within(await card()).getByRole("img", { name: "Pinned" })).toBeDefined();
  });

  it("does not offer a second change of the bookmark while the first is being saved", async () => {
    const answer = gate();
    const server = stubServer({
      patch: async () => {
        await answer.open;
        return json({ ...BOOKMARK, pinned: true, version: 4 });
      },
    });
    await openApp();
    await card();
    await chooseAction("Pin");
    await within(await card()).findByRole("img", { name: "Pinned" });

    await press(screen.getByRole("button", { name: "Actions for Example docs" }));
    const item = await screen.findByRole("menuitem", { name: "Unpin" });

    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    // A second update would reach the server within this wait.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(server.patches).toHaveLength(1);
    await act(async () => {
      answer.release();
      await Promise.resolve();
    });
  });

  it("takes the pin off the card when the server refuses, even if the list cannot be read again", async () => {
    let reads = 0;
    stubServer({
      list: () => {
        reads += 1;
        return reads === 1 ? json({ items: [BOOKMARK], nextCursor: null, total: 1 }) : problem(429, "rate_limited", "req-429");
      },
      patch: () => problem(503, "unavailable", "req-503"),
    });
    await openApp();
    await card();

    await chooseAction("Pin");

    expect((await screen.findAllByText("The bookmark could not be pinned. Try again in a moment.")).length).toBeGreaterThan(0);
    expect(await screen.findByText(/The list could not be refreshed/)).toBeDefined();
    expect(within(await card()).queryByRole("img", { name: "Pinned" })).toBeNull();
    expect(reads).toBeGreaterThan(1);
  });
});
