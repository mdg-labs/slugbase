import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { focusManager } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, MEMBERSHIPS_BODY, WORKSPACE_ID, allowSlowRender, json, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// An account in the export-only access mode through the app (doc 02 section 2.11, doc 03 section 11.5 and the persistent banners): the app shows
// the banner with the end date and the export page and nothing else, and sends no request the server refuses. The failure scenarios are a page
// of the app that still loads and asks for what the server refuses (a refused session check taken as a signed-out visitor, a dashboard, the
// entitlements), an import offered that the server would refuse, a banner without the end date, a deep link that opens a page of the app, and
// an app that keeps showing the full interface after the server began to refuse it.

const server = createMockServer();
const document_ = readOpenApiDocument();

const UNTIL = "2026-12-01T10:00:00.000Z";
const OTHER_WORKSPACE = "0192f3a0-cccc-7000-8000-000000000002";
const JSON_FILE = '{"format":"slugbase-export","version":1,"bookmarks":[]}';
const REQUEST_ID = "req-export-only";

interface World {
  mode: "full" | "exportOnly";
  memberships: { workspaceId: string; name: string; role: "owner" }[];
  /** Every request the app sent to the API, as `METHOD /path`. */
  requests: string[];
  /** The export requests, with their query. */
  exports: string[];
}

let world: World;

function exportOnlyProblem(): Response {
  return json(
    { type: "https://slugbase.app/problems/account_export_only", title: "Account is export-only", status: 403, code: "account_export_only", detail: "The account only exports.", requestId: REQUEST_ID, until: UNTIL },
    { status: 403, contentType: "application/problem+json" },
  );
}

function meBody(): object {
  return {
    account: { ...ACCOUNT_BODY, accessMode: world.mode, exportOnlyUntil: world.mode === "exportOnly" ? UNTIL : null },
    memberships: world.memberships,
    activeWorkspaceId: WORKSPACE_ID,
  };
}

function serve(): void {
  server.events.on("request:start", ({ request }) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      world.requests.push(`${request.method} ${pathname}`);
    }
  });
  // The handlers made from the document answer every operation; those of a later call take precedence over them.
  server.use(...createHandlers(document_, { scenario: { name: "export-only" } }));
  server.use(
    ...createResolverHandlers(document_, {
      getMe: () => json(meBody()),
      // What the server answers an export-only session: the session check is a refused list.
      listSessions: () => (world.mode === "exportOnly" ? exportOnlyProblem() : json({ items: [], nextCursor: null })),
      exportJson: (request) => {
        world.exports.push(new URL(request.url).search);
        return new Response(JSON_FILE, { headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="slugbase-export-2026-05-05.json"' } });
      },
      setActiveWorkspace: () => new Response(null, { status: 204 }),
      listBookmarks: () => {
        if (world.mode === "full") {
          world.mode = "exportOnly";
        }
        return exportOnlyProblem();
      },
    }),
  );
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});

afterAll(() => {
  server.close();
});

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
});

afterAll(() => {
  restoreWait();
});

beforeEach(() => {
  world = { mode: "exportOnly", memberships: [...MEMBERSHIPS_BODY], requests: [], exports: [] };
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: () => "blob:export-1" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: () => undefined });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  serve();
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

async function open(path: string): Promise<void> {
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

/** The requests that are not the app finding out who it is: the configuration, the account and the check of the session. */
const beyondSignIn = (): string[] => world.requests.filter((request) => !["GET /api/config", "GET /api/v1/me", "GET /api/v1/me/sessions"].includes(request));

describe("the app for an account in the export-only access mode", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("opens the export page whatever page was asked for, with the banner naming the end date and a link to the export", async () => {
    await open("/");

    expect(await screen.findByRole("heading", { level: 1, name: "Import & export" })).toBeTruthy();
    const banner = await screen.findByRole("status");
    expect(within(banner).getByText("Your account can only export its data")).toBeTruthy();
    expect(banner.textContent).toContain("Until December 1, 2026");
    expect(within(banner).getByRole("link", { name: "Export my data" }).getAttribute("href")).toBe("/settings/account/data");
    expect(window.location.pathname).toBe("/settings/account/data");
  });

  it("offers the export and nothing the server refuses: no import, no navigation to the pages of the app, no new bookmark, no search, no settings", async () => {
    await open("/settings/account/data");

    await screen.findByRole("heading", { level: 1, name: "Import & export" });
    expect(screen.getByRole("heading", { level: 2, name: "Export bookmarks" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Import bookmarks" })).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    for (const name of ["Bookmarks", "Folders", "Tags", "Forwarding", "Home", "Settings"]) {
      expect(screen.queryByRole("link", { name }), name).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /New bookmark|Add bookmark/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Search|command/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(beyondSignIn()).toEqual([]);
  });

  it("takes the check of the session, which the server refuses an export-only account, for a signed-in visitor", async () => {
    await open("/settings/account/data");

    await screen.findByRole("heading", { level: 1, name: "Import & export" });
    expect(world.requests).toContain("GET /api/v1/me/sessions");
    expect(window.location.pathname).toBe("/settings/account/data");
    expect(screen.queryByRole("heading", { name: /Sign in/i })).toBeNull();
  });

  it("sends a deep link to a page of the app to the export page without asking for that page's data", async () => {
    await open("/bookmarks");

    await screen.findByRole("heading", { level: 1, name: "Import & export" });
    expect(window.location.pathname).toBe("/settings/account/data");
    expect(world.requests).not.toContain("GET /api/v1/bookmarks");
    expect(beyondSignIn()).toEqual([]);
  });

  it("downloads the export, offering the bookmarks shared with the account without reading the entitlements", async () => {
    await open("/settings/account/data");
    await screen.findByRole("heading", { level: 1, name: "Import & export" });

    expect(screen.getByRole("checkbox", { name: /shared/i })).toBeTruthy();
    await press(screen.getByRole("button", { name: /^Download/ }));

    await waitFor(() => {
      expect(world.exports).toEqual(["?includeShared=false"]);
    });
    expect(world.requests).not.toContain("GET /api/v1/entitlements");
  });

  it("lets the account choose the workspace to export from among its own, switching the session's workspace", async () => {
    world.memberships = [...MEMBERSHIPS_BODY, { workspaceId: OTHER_WORKSPACE, name: "Second Workspace", role: "owner" }];
    await open("/settings/account/data");
    await screen.findByRole("heading", { level: 1, name: "Import & export" });

    await press(await screen.findByRole("combobox", { name: "Workspace to export from" }));
    await act(async () => {
      const item = await screen.findByRole("option", { name: "Second Workspace" });
      fireEvent.pointerDown(item);
      fireEvent.click(item);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(world.requests).toContain("PUT /api/v1/session/active-workspace");
    });
  });

  it("shows no choice of workspace for an account with one", async () => {
    await open("/settings/account/data");
    await screen.findByRole("heading", { level: 1, name: "Import & export" });
    expect(screen.queryByRole("combobox", { name: "Workspace to export from" })).toBeNull();
  });
});

describe("the app for an account that began to be refused", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("reads the account again after a request is refused with account_export_only, and replaces the pages of the app with the export page", async () => {
    world.mode = "full";
    await open("/bookmarks");

    expect(await screen.findByRole("heading", { level: 1, name: "Import & export" })).toBeTruthy();
    const banner = await screen.findByRole("status");
    expect(within(banner).getByText("Your account can only export its data")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(window.location.pathname).toBe("/settings/account/data");
    expect(world.requests.filter((request) => request === "GET /api/v1/me").length).toBeGreaterThan(1);
  });

  it("gives the full app back, without a reload, when the window regains focus after an instance admin ended the period", async () => {
    await open("/settings/account/data");
    await screen.findByText("Your account can only export its data");
    expect(screen.queryByRole("heading", { name: "Import bookmarks" })).toBeNull();

    world.mode = "full";
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { name: "Import bookmarks" })).toBeTruthy();
    expect(screen.queryByText("Your account can only export its data")).toBeNull();
  });

  it("keeps the full app, with no banner, for an account with full access", async () => {
    world.mode = "full";
    server.use(...createResolverHandlers(document_, { listBookmarks: () => json({ items: [], nextCursor: null }) }));
    await open("/settings/account/data");

    await screen.findByRole("heading", { level: 1, name: "Import & export" });
    expect(screen.getByRole("heading", { name: "Import bookmarks" })).toBeTruthy();
    expect(screen.queryByText("Your account can only export its data")).toBeNull();
    expect(screen.getByRole("link", { name: "Bookmarks" })).toBeTruthy();
  });
});
