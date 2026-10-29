import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The Share action of the bulk bar (doc 03 section 3.4, doc 02 section 5.8, doc 10 T2 and T11) against a server that keeps its own
// bookmarks. The failure scenarios are a Share that is sent without the preview of who gets the bookmarks being shown, a Share that is
// offered where the workspace may not share, a share that can be started for a selection the preview says nothing in can be shared,
// a failed request that reports success or loses the selection, a result that hides the skipped count, and an action that can be
// started again while one runs.

type Bookmark = ComponentTypes["schemas"]["Bookmark"];

const OWNER = "0192f3a0-bbbb-7000-8000-000000000001";
const GRACE = "0192f3a0-bbbb-7000-8000-000000000002";
const DESIGN = "0192f3a0-cccc-7000-8000-000000000001";
const LIST = "/api/v1/bookmarks";

function idOf(n: number): string {
  return `0192f3a0-aaaa-7000-8000-${String(n).padStart(12, "0")}`;
}

function bookmark(n: number): Bookmark {
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
    tags: [],
    version: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
  };
}

interface ShareBody {
  action: string;
  ids: string[];
  accountId?: string;
  teamId?: string;
}

interface World {
  sharing: boolean;
  /** Answers the bulk request; the default counts every named bookmark. */
  bulk: (body: ShareBody) => Response | Promise<Response>;
  preview: (body: ShareBody) => Response | Promise<Response>;
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let world: World;
let calls: Call[] = [];

function result(requested: number, affected = requested): Response {
  return json({ requested, affected, skipped: requested - affected, skippedReasons: { not_owner: 0, not_found: requested - affected } });
}

function previewOf(body: ShareBody): Response {
  const team = body.teamId !== undefined;
  const named = body.ids.length;
  return json({
    requested: named,
    affected: named,
    skipped: 0,
    skippedReasons: { not_owner: 0, not_found: 0 },
    tags: [],
    audience: team ? { kind: "team", id: DESIGN, name: "Design", memberCount: 4, added: named } : { kind: "member", id: GRACE, name: "Grace", memberCount: 1, added: named - 1 },
  });
}

function reset(): void {
  world = { sharing: true, bulk: (body) => result(body.ids.length), preview: previewOf };
  calls = [];
}

function entitlementsBody() {
  return {
    entitlements: {
      "bookmarks.max": "unlimited",
      "seats.max": "unlimited",
      "workspaces.ownMax": "unlimited",
      "ai.suggestions": true,
      "sharing.members": world.sharing,
      "sharing.teams": world.sharing,
      "members.invite": true,
      "teams.manage": true,
      "audit.log": true,
    },
    usage: { "bookmarks.used": 3, "seats.used": 3, "workspaces.owned": 1 },
    upgradeAvailable: true,
  };
}

function serve(): void {
  vi.stubGlobal("fetch", (request: Request) =>
    signedIn(request, async () => {
      const { pathname } = new URL(request.url);
      const body: unknown = request.method === "POST" ? await request.clone().json() : undefined;
      calls.push({ method: request.method, path: pathname, body });
      if (pathname === LIST) {
        return json({ items: [bookmark(1), bookmark(2), bookmark(3)], nextCursor: null, total: 3 });
      }
      if (pathname === "/api/v1/entitlements") {
        return json(entitlementsBody());
      }
      if (pathname === "/api/v1/share-targets") {
        return json({
          items: [
            { kind: "member", id: GRACE, name: "Grace", email: "grace@example.test" },
            { kind: "team", id: DESIGN, name: "Design", email: null },
          ],
        });
      }
      if (pathname === `${LIST}/bulk`) {
        return world.bulk(body as ShareBody);
      }
      if (pathname === `${LIST}/bulk/preview`) {
        return world.preview(body as ShareBody);
      }
      throw new Error(`unexpected call ${request.method} ${pathname}`);
    }),
  );
}

function to(path: string): Call[] {
  return calls.filter((call) => call.method === "POST" && call.path === path);
}

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
});

afterAll(() => {
  restoreWait();
});

beforeEach(() => {
  reset();
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  serve();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openApp(): Promise<void> {
  window.history.replaceState(null, "", "/bookmarks");
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

async function select(...numbers: number[]): Promise<void> {
  for (const n of numbers) {
    await press(screen.getByRole("checkbox", { name: `Select Bookmark ${String(n)}` }));
  }
}

function bar(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Selected bookmarks" });
}

async function openShare(title: string): Promise<HTMLElement> {
  await press(within(bar()).getByRole("button", { name: "Share" }));
  return screen.findByRole("dialog", { name: title });
}

async function choose(dialog: HTMLElement, option: string): Promise<void> {
  const input = within(dialog).getByRole("combobox", { name: "Share with" });
  await act(async () => {
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
  const item = await screen.findByRole("option", { name: new RegExp(`^${option}`, "u"), hidden: true });
  await act(async () => {
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(document.querySelector("[data-slot='picker-popup']")).toBeNull();
  });
}

/** The live region of the page, which the toasts' own region is not. */
function liveRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>("p.sr-only[role='status']");
  expect(region).not.toBeNull();
  return region as HTMLElement;
}

function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe("sharing the selection", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks who to share with, shows the preview of the choice before anything is sent, and shares with the member", async () => {
    const held = gate();
    world.bulk = async (body) => {
      await held.wait;
      return result(body.ids.length);
    };
    await openApp();
    await select(1, 2);

    const dialog = await openShare("Share 2 bookmarks");
    expect(within(dialog).getByRole("button", { name: "Share" }).hasAttribute("disabled")).toBe(true);
    expect(to(`${LIST}/bulk/preview`)).toHaveLength(0);
    await choose(dialog, "Grace");

    await within(dialog).findByText("2 bookmarks will be shared with Grace.");
    within(dialog).getByText("1 new share is made.");
    within(dialog).getByText("1 member can read them.");
    expect(to(`${LIST}/bulk/preview`)[0]?.body).toEqual({ action: "share", ids: [idOf(1), idOf(2)], accountId: GRACE });
    expect(to(`${LIST}/bulk`)).toHaveLength(0);
    await press(within(dialog).getByRole("button", { name: "Share" }));

    await waitFor(() => {
      expect(to(`${LIST}/bulk`)).toHaveLength(1);
    });
    expect(to(`${LIST}/bulk`)[0]?.body).toEqual({ action: "share", ids: [idOf(1), idOf(2)], accountId: GRACE });
    // The bar waits for the answer.
    const busyBar = document.querySelector<HTMLElement>("[data-slot='bulk-bar']") as HTMLElement;
    expect(busyBar.getAttribute("aria-busy")).toBe("true");
    expect(within(busyBar).getByRole("button", { name: "Pin", hidden: true }).getAttribute("aria-disabled")).toBe("true");
    expect(within(busyBar).getByRole("button", { name: /^Share/, hidden: true }).hasAttribute("data-loading")).toBe(true);

    await act(async () => {
      held.open();
      await held.wait;
    });
    await waitFor(() => {
      expect(screen.queryByRole("toolbar")).toBeNull();
    });
    expect(liveRegion().textContent).toBe("2 bookmarks shared with Grace.");
    expect((await screen.findAllByText("2 bookmarks shared with Grace.")).length).toBeGreaterThan(1);
  });

  it("shares with a team by its identifier, and says how many members read through it", async () => {
    await openApp();
    await select(1, 2, 3);

    const dialog = await openShare("Share 3 bookmarks");
    await choose(dialog, "Design");

    await within(dialog).findByText("3 bookmarks will be shared with Design.");
    within(dialog).getByText("4 members can read them.");
    await press(within(dialog).getByRole("button", { name: "Share" }));

    await waitFor(() => {
      expect(to(`${LIST}/bulk`)).toHaveLength(1);
    });
    expect(to(`${LIST}/bulk`)[0]?.body).toEqual({ action: "share", ids: [idOf(1), idOf(2), idOf(3)], teamId: DESIGN });
  });

  it("states the skipped count beside the affected count, in the preview and in the result", async () => {
    world.preview = () => json({ requested: 2, affected: 1, skipped: 1, skippedReasons: { not_owner: 0, not_found: 1 }, tags: [], audience: { kind: "member", id: GRACE, name: "Grace", memberCount: 1, added: 1 } });
    world.bulk = () => result(2, 1);
    await openApp();
    await select(1, 2);
    const dialog = await openShare("Share 2 bookmarks");
    await choose(dialog, "Grace");

    await within(dialog).findByText("1 bookmark will be shared with Grace.");
    within(dialog).getByText("1 bookmark will be skipped because it no longer exists or can’t be changed.");
    await press(within(dialog).getByRole("button", { name: "Share" }));

    await waitFor(() => {
      expect(liveRegion().textContent).toBe("1 bookmark shared with Grace. 1 bookmark was skipped because it no longer exists or can’t be changed.");
    });
  });

  it("keeps Share off when the preview says no bookmark of the selection can be shared, and sends nothing", async () => {
    world.preview = () => json({ requested: 2, affected: 0, skipped: 2, skippedReasons: { not_owner: 0, not_found: 2 }, tags: [], audience: { kind: "member", id: GRACE, name: "Grace", memberCount: 1, added: 0 } });
    await openApp();
    await select(1, 2);
    const dialog = await openShare("Share 2 bookmarks");

    await choose(dialog, "Grace");

    await within(dialog).findByText("None of these bookmarks can be shared.");
    expect(within(dialog).getByRole("button", { name: "Share" }).hasAttribute("disabled")).toBe(true);
    expect(to(`${LIST}/bulk`)).toHaveLength(0);
  });

  it("says so, instead of offering a share, when the preview cannot be loaded, and offers to try again", async () => {
    let failing = true;
    world.preview = (body) => (failing ? problem(503, "internal_error", "req-preview") : previewOf(body));
    await openApp();
    await select(1, 2);
    const dialog = await openShare("Share 2 bookmarks");
    await choose(dialog, "Grace");

    await within(dialog).findByText("The preview could not be loaded.");
    expect(within(dialog).getByRole("button", { name: "Share" }).hasAttribute("disabled")).toBe(true);
    failing = false;
    await press(within(dialog).getByRole("button", { name: "Try again" }));

    await within(dialog).findByText("2 bookmarks will be shared with Grace.");
    expect(within(dialog).getByRole("button", { name: "Share" }).hasAttribute("disabled")).toBe(false);
  });

  it("tells the member, and keeps the selection, when the request fails", async () => {
    world.bulk = () => problem(503, "internal_error", "req-bulk");
    await openApp();
    await select(1, 2);
    const dialog = await openShare("Share 2 bookmarks");
    await choose(dialog, "Grace");
    await within(dialog).findByText("2 bookmarks will be shared with Grace.");

    await press(within(dialog).getByRole("button", { name: "Share" }));

    expect((await screen.findAllByText("The bookmarks could not be shared. Nothing was changed. Try again in a moment.")).length).toBeGreaterThan(0);
    expect(within(bar()).getByText("2 selected")).toBeDefined();
    expect(screen.queryByText(/bookmarks shared with/)).toBeNull();
  });

  it("names the member who is gone when the server refuses the target, and keeps the selection", async () => {
    world.bulk = () => problem(422, "validation_failed", "req-bulk");
    await openApp();
    await select(1);
    const dialog = await openShare("Share 1 bookmark");
    await choose(dialog, "Grace");
    await within(dialog).findByText("1 bookmark will be shared with Grace.");

    await press(within(dialog).getByRole("button", { name: "Share" }));

    expect((await screen.findAllByText("Grace is no longer a member or team of this workspace. Nothing was changed.")).length).toBeGreaterThan(0);
    expect(within(bar()).getByText("1 selected")).toBeDefined();
  });

  it("offers no Share where the workspace may not share, and sends nothing", async () => {
    world.sharing = false;
    await openApp();
    await select(1, 2);

    await waitFor(() => {
      expect(calls.some((call) => call.path === "/api/v1/entitlements")).toBe(true);
    });
    expect(within(bar()).queryByRole("button", { name: "Share" })).toBeNull();
    expect(within(bar()).getByRole("button", { name: "Pin" })).toBeDefined();
    expect(to(`${LIST}/bulk`)).toHaveLength(0);
  });
});
