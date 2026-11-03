import type { ComponentTypes } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp, type WebExtension } from "../src/index.ts";
import { ACCOUNT_BODY, WORKSPACE_ID, allowSlowRender, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// /settings/workspace/audit (doc 03 section 11.9, doc 02 section 10) against the handlers generated from openapi.json, through the app's own
// API client. The failure scenarios are a list that fails shown as empty, a member's visit that still requests the log, a gated workspace
// that still requests it, a deleted account's event shown under another name, event text built into markup or into a link to a member's
// content, a failed next page that drops the rows already shown, and the events of one workspace shown in another.

type AuditEvent = ComponentTypes["schemas"]["AuditEvent"];
type Role = "owner" | "admin" | "member";

const server = createMockServer();
const document_ = readOpenApiDocument();

const ADA = ACCOUNT_BODY.id;
const GRACE = "0192f3a0-bbbb-7000-8000-000000000002";
const TEAM = "0192f3a0-ffff-7000-8000-000000000001";
const BOOKMARK = "0192f3a0-aaaa-7000-8000-000000000001";
const SECOND_ID = "0192f3a0-cccc-7000-8000-000000000009";
const SECOND_NAME = "Second Workspace";
const STAMP = "2026-10-01T08:00:00.000Z";
const NEXT = "cursor-two";

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

function event(n: number, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `0192f3a0-eeee-7000-8000-${String(n).padStart(12, "0")}`,
    createdAt: hoursAgo(n),
    actor: { type: "account", accountId: ADA, label: "Ada Lovelace" },
    action: "team.created",
    category: "team",
    entity: { type: "team", id: TEAM },
    metadata: { name: `Team ${String(n)}` },
    ...overrides,
  };
}

const FIRST_PAGE = [event(2), event(3, { action: "member.removed", category: "member", entity: { type: "member", id: GRACE }, metadata: { content: "delete" } }), event(4)];
const SECOND_PAGE = [event(5), event(6)];

interface World {
  role: Role;
  auditLog: boolean;
  /** Holds the answer to the entitlements until it settles. */
  entitlementsHeld?: Promise<void>;
  /** The workspace the session acts in. */
  active: string;
  /** The events of a workspace, as pages: the first without a cursor, then each by the cursor the page before named. */
  pages: Map<string, AuditEvent[][]>;
  /** operationId to the answer that replaces the operation's own for as long as it returns one; `call` counts from 1. */
  refuse: Map<string, (call: number) => Response | undefined | Promise<Response | undefined>>;
  calls: Map<string, number>;
  received: URL[];
}

let world: World;

function newWorld(overrides: Partial<World> = {}): World {
  return {
    role: "owner",
    auditLog: true,
    active: WORKSPACE_ID,
    pages: new Map([[WORKSPACE_ID, [FIRST_PAGE, SECOND_PAGE]]]),
    refuse: new Map(),
    calls: new Map(),
    received: [],
    ...overrides,
  };
}

function entitlementsBody() {
  return {
    entitlements: {
      "bookmarks.max": "unlimited",
      "seats.max": "unlimited",
      "workspaces.ownMax": "unlimited",
      "ai.suggestions": true,
      "sharing.members": true,
      "sharing.teams": true,
      "members.invite": true,
      "teams.manage": true,
      "audit.log": world.auditLog,
    },
    usage: { "bookmarks.used": 0, "seats.used": 2, "workspaces.owned": 1 },
    upgradeAvailable: true,
  };
}

const MEMBERSHIPS = () => [
  { workspaceId: WORKSPACE_ID, name: "Ada's Workspace", role: world.role },
  { workspaceId: SECOND_ID, name: SECOND_NAME, role: world.role },
];

function serve(): void {
  server.use(
    ...createResolverHandlers(document_, {
      getMe: () => json({ account: { ...ACCOUNT_BODY, locale: globalThis.navigator.languages.some((language) => language.startsWith("de")) ? "de" : "en" }, memberships: MEMBERSHIPS(), activeWorkspaceId: world.active }),
      getWorkspace: () => {
        const membership = MEMBERSHIPS().find(({ workspaceId }) => workspaceId === world.active);
        return json({ id: world.active, name: membership?.name ?? "", role: world.role, memberCount: 2, createdAt: STAMP, version: 1 }, { headers: { ETag: '"1"' } });
      },
      getEntitlements: async () => {
        await world.entitlementsHeld;
        return json(entitlementsBody());
      },
      setActiveWorkspace: async (request) => {
        world.active = ((await request.json()) as { workspaceId: string }).workspaceId;
        return new Response(null, { status: 204 });
      },
      listAuditEvents: async (request) => {
        const url = new URL(request.url);
        world.received.push(url);
        const call = (world.calls.get("listAuditEvents") ?? 0) + 1;
        world.calls.set("listAuditEvents", call);
        const steered = await world.refuse.get("listAuditEvents")?.(call);
        if (steered !== undefined) {
          return steered;
        }
        const pages = world.pages.get(world.active) ?? [[]];
        const cursor = url.searchParams.get("cursor");
        const index = cursor === null ? 0 : 1;
        return json({ items: pages[index] ?? [], nextCursor: index + 1 < pages.length ? NEXT : null });
      },
    }),
    ...createHandlers(document_, {
      scenario: {
        name: "audit",
        fixtures: {
          listWorkspaces: {
            items: MEMBERSHIPS().map(({ workspaceId, name, role }) => ({ id: workspaceId, name, role, memberCount: 2 })),
            canCreate: false,
          },
        },
      },
    }),
  );
}

function auditCalls(): URL[] {
  return world.received;
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
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
  world = newWorld();
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

const UPGRADE: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <a href="/settings/billing">Upgrade plan</a> } };

async function open(path: string, extensions: readonly WebExtension[] = []): Promise<void> {
  serve();
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

async function openTable(extensions: readonly WebExtension[] = []): Promise<HTMLElement> {
  await open("/settings/workspace/audit", extensions);
  return screen.findByRole("table", { name: "Audit log" });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

function rowOf(text: string): HTMLElement {
  const row = within(screen.getByRole("table"))
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(text) !== null);
  if (row === undefined) {
    throw new Error(`no row with ${text}`);
  }
  return row;
}

async function noViolations(): Promise<void> {
  const results = await axe(document.body, { rules: { region: { enabled: false } } });
  expect(results.violations.map(({ id }) => id)).toEqual([]);
}

describe("the navigation", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it.each<Role>(["owner", "admin"])("lists the Audit log in the Workspace group for an %s and opens the page", async (role) => {
    world.role = role;
    await open("/settings/account");

    const group = await within(await screen.findByRole("navigation", { name: "Settings" })).findByRole("list", { name: "Workspace" });
    await press(within(group).getByRole("link", { name: "Audit log" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Audit log" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/workspace/audit");
    expect(within(screen.getByRole("navigation", { name: "Settings" })).getByRole("link", { name: "Audit log" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("table", { name: "Audit log" })).toBeTruthy();
  });

  it("does not list it for a member", async () => {
    world.role = "member";
    await open("/settings/account");

    const group = await within(await screen.findByRole("navigation", { name: "Settings" })).findByRole("list", { name: "Workspace" });
    expect(within(group).getByRole("link", { name: "General" })).toBeTruthy();
    expect(within(group).queryByRole("link", { name: "Audit log" })).toBeNull();
  });

  it("does not list it where the workspace lacks audit.log, once the entitlements say so", async () => {
    world.auditLog = false;
    await open("/settings/account");

    const group = await within(await screen.findByRole("navigation", { name: "Settings" })).findByRole("list", { name: "Workspace" });
    await waitFor(() => {
      expect(within(group).queryByRole("link", { name: "Audit log" })).toBeNull();
    });
    expect(within(group).getByRole("link", { name: "AI suggestions" })).toBeTruthy();
  });

  it("offers it in the Select of a narrow screen for an admin and goes to the page", async () => {
    world.role = "admin";
    stubMatchMedia(true);
    await open("/settings/account");

    await press(await screen.findByRole("combobox", { name: "Settings" }));
    const option = await screen.findByRole("option", { name: "Audit log" });
    await act(async () => {
      fireEvent.pointerDown(option);
      fireEvent.click(option);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings/workspace/audit");
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Audit log" })).toBeTruthy();
  });

  it("does not offer it in the Select for a member", async () => {
    world.role = "member";
    stubMatchMedia(true);
    await open("/settings/account");

    await press(await screen.findByRole("combobox", { name: "Settings" }));
    expect(await screen.findByRole("option", { name: "General" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Audit log" })).toBeNull();
  });

  it("shows a member who opens the address the 403 page, without asking for the log", async () => {
    world.role = "member";
    await open("/settings/workspace/audit");

    expect(await screen.findByRole("heading", { name: "You don't have access" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(auditCalls()).toEqual([]);
  });
});

describe("a workspace without audit.log", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the title and the upgrade slot in place of the table, and never asks for the log", async () => {
    world.auditLog = false;
    await open("/settings/workspace/audit", [UPGRADE]);

    expect(await screen.findByRole("link", { name: "Upgrade plan" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Audit log" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("No events yet")).toBeNull();
    expect(auditCalls()).toEqual([]);
  });

  it("holds the log back while the entitlements are not known, and still never asks for it once they say no", async () => {
    world.auditLog = false;
    let release: () => void = () => undefined;
    world.entitlementsHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    await open("/settings/workspace/audit", [UPGRADE]);

    expect(await screen.findByRole("status", { name: "Loading the audit log" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Audit log" })).toBeTruthy();
    expect(auditCalls()).toEqual([]);
    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(await screen.findByRole("link", { name: "Upgrade plan" })).toBeTruthy();
    expect(auditCalls()).toEqual([]);
  });

  it("shows the title and nothing broken where nothing fills the upgrade slot", async () => {
    world.auditLog = false;
    await open("/settings/workspace/audit");

    expect(await screen.findByRole("heading", { level: 1, name: "Audit log" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: "Loading the audit log" })).toBeNull();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(auditCalls()).toEqual([]);
  });

  it("shows the gate's content, not an error, where the server refuses with entitlement_required", async () => {
    world.refuse.set("listAuditEvents", () => problem(403, "entitlement_required", "req-403"));
    await open("/settings/workspace/audit", [UPGRADE]);

    expect(await screen.findByRole("link", { name: "Upgrade plan" })).toBeTruthy();
    expect(screen.queryByText("The audit log could not be loaded")).toBeNull();
    expect(screen.queryByText("No events yet")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("the table", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("lists the events newest first as the API returns them, with time, actor, action and target", async () => {
    const table = await openTable();

    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Time", "Actor", "Action", "Target"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => within(row).getAllByRole("cell")[2]?.textContent)).toEqual(["Team createdTeam", "Member removedMember", "Team createdTeam"]);
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]?.searchParams.get("cursor")).toBeNull();
  });

  it("shows the time as how long ago, in a time element that carries the instant", async () => {
    world.pages.set(WORKSPACE_ID, [[event(2, { createdAt: hoursAgo(2) })]]);
    const table = await openTable();

    const [time] = Array.from(table.querySelectorAll("time"));
    expect(time?.textContent).toBe("2 hr. ago");
    expect(time?.getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("shows the actor with the name the event kept, and what it is where it is no account", async () => {
    world.pages.set(WORKSPACE_ID, [
      [
        event(1),
        event(2, { actor: { type: "account", accountId: null, label: "Grace Hopper" } }),
        event(3, { actor: { type: "system", accountId: null, label: "SlugBase" } }),
        event(4, { actor: { type: "api_token", accountId: ADA, label: "CI token" } }),
      ],
    ]);
    await openTable();

    const deleted = rowOf("Grace Hopper");
    expect(within(deleted).getByText("deleted account")).toBeTruthy();
    expect(within(rowOf("SlugBase")).getByText("System")).toBeTruthy();
    expect(within(rowOf("CI token")).getByText("API token")).toBeTruthy();
    const live = rowOf("Ada Lovelace");
    expect(within(live).queryByText("deleted account")).toBeNull();
    expect(within(live).queryByText("System")).toBeNull();
  });

  it("shows the localised action with the badge of its category, and the recorded name with a neutral badge for an action the catalog no longer holds", async () => {
    world.pages.set(WORKSPACE_ID, [[event(1, { action: "share.granted", category: "share" }), event(2, { action: "retired.thing", category: null, entity: null, metadata: {} })]]);
    await openTable();

    const known = rowOf("Share granted");
    expect(within(known).getByText("Sharing")).toBeTruthy();
    const retired = rowOf("retired.thing");
    expect(within(retired).getByText("Other")).toBeTruthy();
    expect(within(retired).getByText("No target")).toBeTruthy();
  });

  it("shows the kind of thing and its name as text, a share's recipient after 'with', and a rename's new name", async () => {
    world.pages.set(WORKSPACE_ID, [
      [
        event(1, { action: "team.created", metadata: { name: "Platform" } }),
        event(2, { action: "share.granted", category: "share", entity: { type: "bookmark", id: BOOKMARK }, metadata: { targetKind: "member", targetId: GRACE, targetName: "Grace Hopper" } }),
        event(3, { action: "workspace.renamed", category: "workspace", entity: { type: "workspace", id: WORKSPACE_ID }, metadata: { from: "Old", to: "New name" } }),
        event(4, { action: "member.role_changed", category: "member", entity: { type: "member", id: GRACE }, metadata: { from: "member", to: "admin" } }),
      ],
    ]);
    await openTable();

    const targetOf = (row: HTMLElement): string | undefined => within(row).getAllByRole("cell")[3]?.textContent;
    expect(targetOf(rowOf("Platform"))).toBe("Team" + "Platform");
    expect(targetOf(rowOf("Share granted"))).toBe("Bookmark" + "with Grace Hopper");
    expect(targetOf(rowOf("New name"))).toBe("Workspace" + "New name");
    expect(targetOf(rowOf("Member role changed"))).toBe("Member");
  });

  it("renders event text as characters, creates no element from it and links to no bookmark or folder", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    world.pages.set(WORKSPACE_ID, [
      [
        event(1, { actor: { type: "account", accountId: ADA, label: hostile }, metadata: { name: hostile } }),
        event(2, { action: "share.granted", category: "share", entity: { type: "bookmark", id: BOOKMARK }, metadata: { targetKind: "team", targetId: TEAM, targetName: "<a href=\"javascript:alert(1)\">x</a>" } }),
      ],
    ]);
    const table = await openTable();

    expect(within(table).getAllByText(hostile).length).toBeGreaterThanOrEqual(2);
    expect(within(table).getByText('with <a href="javascript:alert(1)">x</a>')).toBeTruthy();
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(table.querySelectorAll("img, a")).toHaveLength(0);
    expect(within(table).queryAllByRole("link")).toEqual([]);
  });

  it("has no accessibility violations", async () => {
    const table = await openTable();
    await within(table).findAllByRole("row");

    await noViolations();
  });
});

describe("load more", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("says how many events are shown, loads the next page by its cursor and appends it, and goes away on the last page", async () => {
    const table = await openTable();

    expect(screen.getByText("Showing 3 events")).toBeTruthy();
    await press(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => {
      expect(within(table).getAllByRole("row")).toHaveLength(6);
    });
    expect(screen.getByText("Showing 5 events")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(auditCalls().map((url) => url.searchParams.get("cursor"))).toEqual([null, NEXT]);
    expect(screen.queryByText(/page \d|of \d+ events/i)).toBeNull();
  });

  it("offers no button when the first page is the last", async () => {
    world.pages.set(WORKSPACE_ID, [FIRST_PAGE]);
    await openTable();

    expect(screen.getByText("Showing 3 events")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps the rows shown when the next page fails, and loads it on retry", async () => {
    world.refuse.set("listAuditEvents", (call) => (call === 2 ? problem(400, "bad_request", "req-400") : undefined));
    const table = await openTable();
    await press(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("More events could not be loaded")).toBeTruthy();
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(screen.queryByText("The audit log could not be loaded")).toBeNull();
    expect(screen.queryByText("No events yet")).toBeNull();
    await press(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(within(table).getAllByRole("row")).toHaveLength(6);
    });
    expect(screen.queryByText("More events could not be loaded")).toBeNull();
    expect(auditCalls().map((url) => url.searchParams.get("cursor"))).toEqual([null, NEXT, NEXT]);
  });
});

describe("the states", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows skeleton rows in a status region while the first page loads", async () => {
    let release: (response: Response) => void = () => undefined;
    world.refuse.set("listAuditEvents", () => new Promise<Response>((resolve) => (release = resolve)));
    await open("/settings/workspace/audit");

    const status = await screen.findByRole("status", { name: "Loading the audit log" });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("No events yet")).toBeNull();
    await noViolations();
    await act(async () => {
      release(json({ items: FIRST_PAGE, nextCursor: null }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("table", { name: "Audit log" })).toBeTruthy();
  });

  it("teaches what is recorded when the workspace has no events", async () => {
    world.pages.set(WORKSPACE_ID, [[]]);
    await open("/settings/workspace/audit");

    expect(await screen.findByText("No events yet")).toBeTruthy();
    expect(screen.getByText("Changes to members, teams, sharing and settings are recorded here.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await noViolations();
  });

  it("says the log could not be loaded instead of showing none, and loads it again on retry", async () => {
    world.refuse.set("listAuditEvents", (call) => (call === 1 ? problem(400, "bad_request", "req-400") : undefined));
    await open("/settings/workspace/audit");

    expect(await screen.findByText("The audit log could not be loaded")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("No events yet")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    await noViolations();
    await press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("table", { name: "Audit log" })).toBeTruthy();
    expect(screen.queryByText("The audit log could not be loaded")).toBeNull();
  });

  it("has no accessibility violations where the workspace lacks audit.log", async () => {
    world.auditLog = false;
    await open("/settings/workspace/audit", [UPGRADE]);
    await screen.findByRole("link", { name: "Upgrade plan" });

    await noViolations();
  });
});

describe("German", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the labels, the notes and the controls in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    world.pages.set(WORKSPACE_ID, [
      [
        event(1, { action: "member.removed", category: "member", entity: { type: "member", id: GRACE }, actor: { type: "account", accountId: null, label: "Grace Hopper" }, metadata: { content: "delete" } }),
        event(2, { action: "import.completed", category: "import", entity: null, metadata: {} }),
      ],
      [event(3)],
    ]);
    await open("/settings/workspace/audit");

    expect(await screen.findByRole("heading", { level: 1, name: "Audit-Log" })).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Audit-Log" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Zeit", "Akteur", "Aktion", "Ziel"]);
    const removed = rowOf("Mitglied entfernt");
    expect(within(removed).getByText("gelöschtes Konto")).toBeTruthy();
    expect(within(removed).getByText("Grace Hopper")).toBeTruthy();
    expect(within(rowOf("Import abgeschlossen")).getByText("Kein Ziel")).toBeTruthy();
    expect(screen.getByText("2 Ereignisse angezeigt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mehr anzeigen" })).toBeTruthy();
    await noViolations();
  });
});

describe("switching the workspace", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows the events of the workspace switched to and not those of the one left", async () => {
    world.pages.set(WORKSPACE_ID, [[event(1, { actor: { type: "account", accountId: ADA, label: "Ada in the first" } })]]);
    world.pages.set(SECOND_ID, [[event(2, { actor: { type: "account", accountId: GRACE, label: "Grace in the second" } })]]);
    await openTable();
    expect(screen.getByText("Ada in the first")).toBeTruthy();

    await press(await screen.findByRole("button", { name: /^Workspace: / }));
    await press(await screen.findByRole("menuitemradio", { name: SECOND_NAME }));

    expect(await screen.findByText("Grace in the second")).toBeTruthy();
    expect(screen.queryByText("Ada in the first")).toBeNull();
    expect(screen.getByText("Showing 1 event")).toBeTruthy();
  });
});
