import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp, type WebExtension } from "../src/index.ts";
import {
  ACCOUNT_BODY,
  WORKSPACE_ID,
  WORKSPACE_LIST_BODY,
  allowSlowRender,
  json,
  problem,
  renderApp,
  stubBrowserApis,
  stubMatchMedia,
} from "./support.tsx";

// /settings/workspace/teams (doc 03 section 11.8, doc 02 section 4) against the handlers generated from openapi.json, through the
// app's own API client, with teams kept the way the API keeps them. The failure scenarios are a page that offers changes to a plain
// member or without the teams.manage entitlement, a list that failed shown as "No teams yet", a create that sends the members before
// the team exists or that makes a second team when the members step is tried again, an edit that overwrites a version it did not
// read or that sends what has not changed, a taken name shown as a toast instead of at the field, and a delete that does not say
// what happens to what the team shared.

const server = createMockServer();
const document_ = readOpenApiDocument();

const ADA = ACCOUNT_BODY.id;
const GRACE = "0192f3a0-bbbb-7000-8000-000000000002";
const ALAN = "0192f3a0-bbbb-7000-8000-000000000003";
const PLATFORM = "0192f3a0-ffff-7000-8000-000000000001";
const DESIGN = "0192f3a0-ffff-7000-8000-000000000002";
const MADE = "0192f3a0-ffff-7000-8000-000000000099";
const TEAMS_PATH = "/api/v1/teams";
const STAMP = "2026-10-01T08:00:00.000Z";

type Role = "owner" | "admin" | "member";

interface StoredTeam {
  id: string;
  name: string;
  description: string;
  version: number;
  memberIds: string[];
}

interface Person {
  readonly accountId: string;
  readonly displayName: string;
  readonly email: string;
}

const PEOPLE: readonly Person[] = [
  { accountId: ADA, displayName: "Ada Lovelace", email: "ada@example.org" },
  { accountId: GRACE, displayName: "Grace Hopper", email: "grace@example.org" },
  { accountId: ALAN, displayName: "Alan Turing", email: "alan@example.org" },
];

interface Received {
  readonly method: string;
  readonly path: string;
  readonly ifMatch: string | null;
  readonly body: unknown;
}

interface World {
  teams: StoredTeam[];
  role: Role;
  teamsManage: boolean;
  received: Received[];
  /** operationId to the answer that replaces the operation's own for as long as it returns one; `call` counts from 1. */
  refuse: Map<string, (call: number) => Response | undefined | Promise<Response | undefined>>;
  calls: Map<string, number>;
}

let world: World;

function newWorld(overrides: Partial<World> = {}): World {
  return { teams: [], role: "owner", teamsManage: true, received: [], refuse: new Map(), calls: new Map(), ...overrides };
}

function team(id: string, name: string, memberIds: string[], overrides: Partial<StoredTeam> = {}): StoredTeam {
  return { id, name, description: "", version: 1, memberIds, ...overrides };
}

function listed(stored: StoredTeam) {
  return {
    id: stored.id,
    name: stored.name,
    description: stored.description,
    memberCount: stored.memberIds.length,
    version: stored.version,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function detailed(stored: StoredTeam) {
  const members = PEOPLE.filter(({ accountId }) => stored.memberIds.includes(accountId)).map(({ accountId, displayName, email }) => ({ accountId, displayName, email }));
  return { ...listed(stored), members };
}

function etag(stored: StoredTeam): { headers: Record<string, string> } {
  return { headers: { ETag: `"${String(stored.version)}"` } };
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
      "teams.manage": world.teamsManage,
      "audit.log": true,
    },
    usage: { "bookmarks.used": 0, "seats.used": 3, "workspaces.owned": 1 },
    upgradeAvailable: true,
  };
}

/** The operation's own answer, unless the test steers it; every call is counted by operation. */
function steered(operationId: string): Response | undefined | Promise<Response | undefined> {
  const call = (world.calls.get(operationId) ?? 0) + 1;
  world.calls.set(operationId, call);
  return world.refuse.get(operationId)?.(call);
}

function record(request: Request, body: unknown): void {
  world.received.push({ method: request.method, path: new URL(request.url).pathname, ifMatch: request.headers.get("If-Match"), body });
}

function find(url: string): StoredTeam | undefined {
  const id = new URL(url).pathname.split("/")[4];
  return world.teams.find((candidate) => candidate.id === id);
}

function taken(name: string, except?: string): boolean {
  return world.teams.some((candidate) => candidate.id !== except && candidate.name.toLowerCase() === name.toLowerCase());
}

function serve(): void {
  server.use(
    ...createResolverHandlers(document_, {
      getMe: () =>
        json({
          account: ACCOUNT_BODY,
          memberships: [{ workspaceId: WORKSPACE_ID, name: "Ada's Workspace", role: world.role }],
          activeWorkspaceId: WORKSPACE_ID,
        }),
      getWorkspace: () =>
        json(
          { id: WORKSPACE_ID, name: "Ada's Workspace", role: world.role, memberCount: 3, createdAt: STAMP, version: 1 },
          { headers: { ETag: '"1"' } },
        ),
      getEntitlements: () => json(entitlementsBody()),
      listMembers: () =>
        json({ items: PEOPLE.map((person) => ({ ...person, role: "member", joinedAt: STAMP, lastActiveAt: null })), nextCursor: null }),
      listTeams: async (request) => {
        record(request, undefined);
        return (
          (await steered("listTeams")) ??
          json({ items: [...world.teams].sort((a, b) => a.name.localeCompare(b.name)).map(listed), nextCursor: null })
        );
      },
      getTeam: async (request) => {
        record(request, undefined);
        const found = find(request.url);
        return (await steered("getTeam")) ?? (found === undefined ? problem(404, "not_found", "req-404") : json(detailed(found), etag(found)));
      },
      createTeam: async (request) => {
        const body = (await request.json()) as { name: string; description?: string };
        record(request, body);
        const steer = await steered("createTeam");
        if (steer !== undefined) {
          return steer;
        }
        if (taken(body.name)) {
          return problem(409, "name_taken", "req-409");
        }
        const made = team(MADE, body.name, [], { description: body.description ?? "" });
        world.teams.push(made);
        return json(detailed(made), { status: 201, ...etag(made) });
      },
      updateTeam: async (request) => {
        const body = (await request.json()) as { name?: string; description?: string };
        record(request, body);
        const steer = await steered("updateTeam");
        if (steer !== undefined) {
          return steer;
        }
        const found = find(request.url);
        if (found === undefined) {
          return problem(404, "not_found", "req-404");
        }
        if (request.headers.get("If-Match") !== `"${String(found.version)}"`) {
          return problem(412, "precondition_failed", "req-412");
        }
        if (body.name !== undefined && taken(body.name, found.id)) {
          return problem(409, "name_taken", "req-409");
        }
        found.name = body.name ?? found.name;
        found.description = body.description ?? found.description;
        found.version += 1;
        return json(detailed(found), etag(found));
      },
      replaceTeamMembers: async (request) => {
        const body = (await request.json()) as { accountIds: string[] };
        record(request, body);
        const steer = await steered("replaceTeamMembers");
        if (steer !== undefined) {
          return steer;
        }
        const found = world.teams.find((candidate) => candidate.id === new URL(request.url).pathname.split("/")[4]);
        if (found === undefined) {
          return problem(404, "not_found", "req-404");
        }
        found.memberIds = [...new Set(body.accountIds)];
        return json(detailed(found), etag(found));
      },
      deleteTeam: async (request) => {
        record(request, undefined);
        const steer = await steered("deleteTeam");
        if (steer !== undefined) {
          return steer;
        }
        const found = find(request.url);
        if (found === undefined) {
          return problem(404, "not_found", "req-404");
        }
        world.teams = world.teams.filter((candidate) => candidate !== found);
        return new Response(null, { status: 204 });
      },
    }),
    ...createHandlers(document_, { scenario: { name: "teams", fixtures: { listWorkspaces: WORKSPACE_LIST_BODY } } }),
  );
}

function calls(method: string, path: string): Received[] {
  return world.received.filter((call) => call.method === method && call.path === path);
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

async function openTeams(extensions: readonly WebExtension[] = []): Promise<void> {
  serve();
  window.history.replaceState(null, "", "/settings/workspace/teams");
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

async function openTable(extensions: readonly WebExtension[] = []): Promise<HTMLElement> {
  await openTeams(extensions);
  return screen.findByRole("table", { name: "Teams" });
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

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table", { name: "Teams" }))
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(name) !== null);
  if (row === undefined) {
    throw new Error(`no row for ${name}`);
  }
  return row;
}

async function chooseAction(name: string, action: "Edit" | "Delete"): Promise<void> {
  await press(within(rowOf(name)).getByRole("button", { name: `Actions for the team ${name}` }));
  await press(await screen.findByRole("menuitem", { name: action }));
}

async function openEdit(name: string): Promise<HTMLElement> {
  await chooseAction(name, "Edit");
  const dialog = await screen.findByRole("dialog", { name: `Edit ${name}` });
  await within(dialog).findByRole("textbox", { name: "Name" });
  return dialog;
}

async function openCreate(): Promise<HTMLElement> {
  await press(await screen.findByRole("button", { name: "Create team" }));
  return screen.findByRole("dialog", { name: "Create team" });
}

async function openMembers(dialog: HTMLElement): Promise<HTMLElement> {
  const input = await within(dialog).findByLabelText("Members");
  await act(async () => {
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
  return input;
}

async function chooseMember(dialog: HTMLElement, name: string): Promise<void> {
  const input = await openMembers(dialog);
  await press(await screen.findByRole("option", { name: new RegExp(`^${name}`), hidden: true }));
  await act(async () => {
    fireEvent.keyDown(input, { key: "Escape" });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(document.querySelector("[data-slot='multi-pick-popup']")).toBeNull();
  });
}

function chips(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll("[data-slot='multi-pick-chip']")].map((chip) => chip.textContent);
}

const PLATFORM_TEAM = (): StoredTeam => team(PLATFORM, "Platform", [ADA, GRACE], { description: "Runs the stack" });
const DESIGN_TEAM = (): StoredTeam => team(DESIGN, "Design", [ALAN]);

describe("the team list", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("lists name, description, the members as an avatar stack and their count, and adds Teams to the Workspace navigation", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    const table = await openTable();

    const columns = within(table).getAllByRole("columnheader").map((header) => header.textContent);
    expect(columns).toEqual(["Name", "Description", "Members", "Actions"]);
    const platform = rowOf("Platform");
    expect(within(platform).getByText("Runs the stack")).toBeTruthy();
    expect(await within(platform).findByRole("img", { name: "Members: Ada Lovelace, Grace Hopper" })).toBeTruthy();
    expect(within(platform).getByText("2")).toBeTruthy();
    expect(await within(rowOf("Design")).findByRole("img", { name: "Members: Alan Turing" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Teams" });
    expect(link.getAttribute("href")).toBe("/settings/workspace/teams");
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("lists the teams in name order and reads each team's members for its avatars", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    const table = await openTable();

    expect(within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual(["Design", "Platform"]);
    await waitFor(() => {
      expect(calls("GET", `${TEAMS_PATH}/${PLATFORM}`)).toHaveLength(1);
      expect(calls("GET", `${TEAMS_PATH}/${DESIGN}`)).toHaveLength(1);
    });
  });

  it("shows a wait with skeleton rows until the list arrives", async () => {
    world.teams = [PLATFORM_TEAM()];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.refuse.set("listTeams", async () => {
      await gate;
      return undefined;
    });
    await openTeams();

    expect(await screen.findByRole("status", { name: "Loading teams" })).toBeTruthy();
    expect(screen.queryByText("No teams yet")).toBeNull();
    expect(screen.queryByRole("table", { name: "Teams" })).toBeNull();
    await act(async () => {
      release();
      await gate;
    });
    expect(await screen.findByRole("table", { name: "Teams" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading teams" })).toBeNull();
  });

  it("teaches what a team is when there is none, with the way to create one", async () => {
    await openTeams();

    expect(await screen.findByRole("heading", { name: "No teams yet" })).toBeTruthy();
    expect(screen.getByText("Create one to group members and share access.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Teams" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create team" })).toBeTruthy();
  });

  it("says the list could not be loaded instead of showing none, and loads it again on retry", async () => {
    world.teams = [PLATFORM_TEAM()];
    // The first read and the two the client repeats on a 5xx fail; the one a retry asks for is answered.
    world.refuse.set("listTeams", (call) => (call <= 3 ? problem(503, "unavailable", "req-503") : undefined));
    await openTeams();

    expect(await screen.findByText("The teams could not be loaded", undefined, { timeout: 8000 })).toBeTruthy();
    expect(screen.queryByText("No teams yet")).toBeNull();
    await press(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("table", { name: "Teams" })).toBeTruthy();
    expect(screen.queryByText("The teams could not be loaded")).toBeNull();
  });

  it("has no accessibility violations", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    const table = await openTable();
    await within(table).findAllByRole("img");

    const results = await axe(document.body, { rules: { region: { enabled: false } } });

    expect(results.violations.map(({ id }) => id)).toEqual([]);
  });
});

describe("a plain member", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("reads the list and is offered no way to change a team", async () => {
    world.role = "member";
    world.teams = [PLATFORM_TEAM()];
    const table = await openTable();

    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Name", "Description", "Members"]);
    expect(await within(rowOf("Platform")).findByRole("img", { name: "Members: Ada Lovelace, Grace Hopper" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create team" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions for the team Platform" })).toBeNull();
    expect(screen.getByRole("link", { name: "Teams" })).toBeTruthy();
  });

  it("is told that an admin creates the first team, without a button to do it", async () => {
    world.role = "member";
    await openTeams();

    expect(await screen.findByRole("heading", { name: "No teams yet" })).toBeTruthy();
    expect(screen.getByText("An admin or owner can create one to group members and share access.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create team" })).toBeNull();
  });
});

describe("the teams.manage entitlement", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  const upgrade: WebExtension = { id: "upgrade", slots: { "entitlement.upgradeAction": () => <a href="/settings/billing">Upgrade plan</a> } };

  it("shows the upgrade affordance in place of the page where the workspace lacks it", async () => {
    world.teamsManage = false;
    world.teams = [PLATFORM_TEAM()];
    await openTeams([upgrade]);

    expect(await screen.findByRole("link", { name: "Upgrade plan" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "Teams" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Teams" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create team" })).toBeNull();
  });

  it("shows nothing broken where nothing fills the upgrade slot", async () => {
    world.teamsManage = false;
    world.teams = [PLATFORM_TEAM()];
    await openTeams();

    // The navigation names the page as current, so the route is mounted; the entitlements have decided once its heading is gone.
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Teams" }).getAttribute("aria-current")).toBe("page");
    });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { level: 1, name: "Teams" })).toBeNull();
    });
    expect(screen.queryByRole("table", { name: "Teams" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create team" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the page where the workspace has it", async () => {
    world.teams = [PLATFORM_TEAM()];
    await openTable([upgrade]);

    expect(screen.getByRole("heading", { level: 1, name: "Teams" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Upgrade plan" })).toBeNull();
  });
});

describe("creating a team", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("creates the team and then puts its members in, and lists it", async () => {
    world.teams = [DESIGN_TEAM()];
    await openTable();
    const dialog = await openCreate();

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "  Platform ");
    await typeInto(within(dialog).getByRole("textbox", { name: "Description" }), "Runs the stack");
    await chooseMember(dialog, "Grace Hopper");
    expect(chips(dialog)).toEqual(["Grace Hopper"]);
    await press(within(dialog).getByRole("button", { name: "Create team" }));

    expect(await screen.findByText("Team created.")).toBeTruthy();
    expect(calls("POST", TEAMS_PATH).map((call) => call.body)).toEqual([{ name: "Platform", description: "Runs the stack" }]);
    expect(calls("PUT", `${TEAMS_PATH}/${MADE}/members`).map((call) => call.body)).toEqual([{ accountIds: [GRACE] }]);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Create team" })).toBeNull();
    });
    expect(await within(await screen.findByRole("table", { name: "Teams" })).findByText("Platform")).toBeTruthy();
  });

  it("sends no members request for a team without members", async () => {
    await openTeams();
    const dialog = await openCreate();

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Platform");
    await press(within(dialog).getByRole("button", { name: "Create team" }));

    expect(await screen.findByText("Team created.")).toBeTruthy();
    expect(calls("POST", TEAMS_PATH)).toHaveLength(1);
    expect(calls("PUT", `${TEAMS_PATH}/${MADE}/members`)).toHaveLength(0);
  });

  it("asks for a name before it sends anything", async () => {
    world.teams = [DESIGN_TEAM()];
    await openTable();
    const dialog = await openCreate();

    await press(within(dialog).getByRole("button", { name: "Create team" }));

    expect(await within(dialog).findByText("Enter a name for the team.")).toBeTruthy();
    expect(calls("POST", TEAMS_PATH)).toHaveLength(0);
  });

  it("shows a name the workspace already uses at the field, without an error toast, and sends no members", async () => {
    world.teams = [PLATFORM_TEAM()];
    await openTable();
    const dialog = await openCreate();

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "platform");
    await chooseMember(dialog, "Alan Turing");
    await press(within(dialog).getByRole("button", { name: "Create team" }));

    expect(await within(dialog).findByText("The workspace already has a team with this name.")).toBeTruthy();
    expect(screen.queryByText("The change was not saved")).toBeNull();
    expect(calls("PUT", `${TEAMS_PATH}/${MADE}/members`)).toHaveLength(0);
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("platform");
    expect(screen.getByRole("dialog", { name: "Create team" })).toBeTruthy();
  });

  it("keeps the team it made when the members step fails, and a second try sends only the members", async () => {
    world.teams = [];
    world.refuse.set("replaceTeamMembers", (call) => (call === 1 ? problem(503, "unavailable", "req-503") : undefined));
    await openTeams();
    const dialog = await openCreate();

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Platform");
    await chooseMember(dialog, "Grace Hopper");
    await press(within(dialog).getByRole("button", { name: "Create team" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("The team could not be saved right now. Try again in a moment.");
    expect(alert.textContent).toContain("Some of your changes were saved, but not all of them.");
    expect(calls("POST", TEAMS_PATH)).toHaveLength(1);
    expect(screen.queryByText("Team created.")).toBeNull();

    await press(within(dialog).getByRole("button", { name: "Create team" }));

    expect(await screen.findByText("Team created.")).toBeTruthy();
    expect(calls("POST", TEAMS_PATH)).toHaveLength(1);
    expect(calls("PUT", `${TEAMS_PATH}/${MADE}/members`).map((call) => call.body)).toEqual([{ accountIds: [GRACE] }, { accountIds: [GRACE] }]);
    expect(world.teams.map((stored) => stored.name)).toEqual(["Platform"]);
  });
});

describe("changing a team", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("starts from the team and its members, and sends the changes against the version it read", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    await openTable();
    const dialog = await openEdit("Platform");

    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Platform");
    expect(within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: "Description" }).value).toBe("Runs the stack");
    expect(chips(dialog)).toEqual(["Ada Lovelace", "Grace Hopper"]);

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Platform team");
    await press(within(dialog).getByRole("button", { name: "Remove Grace Hopper" }));
    await chooseMember(dialog, "Alan Turing");
    expect(chips(dialog)).toEqual(["Ada Lovelace", "Alan Turing"]);
    await press(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Team saved.")).toBeTruthy();
    const patch = calls("PATCH", `${TEAMS_PATH}/${PLATFORM}`);
    expect(patch.map((call) => [call.ifMatch, call.body])).toEqual([['"1"', { name: "Platform team", description: "Runs the stack" }]]);
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`).map((call) => call.body)).toEqual([{ accountIds: [ADA, ALAN] }]);
    expect(await within(await screen.findByRole("table", { name: "Teams" })).findByText("Platform team")).toBeTruthy();
  });

  it("sends only the members when only they changed, and only the fields when only they changed", async () => {
    world.teams = [PLATFORM_TEAM()];
    await openTable();
    const first = await openEdit("Platform");
    await press(within(first).getByRole("button", { name: "Remove Grace Hopper" }));
    await press(within(first).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Team saved.")).toBeTruthy();
    expect(calls("PATCH", `${TEAMS_PATH}/${PLATFORM}`)).toHaveLength(0);
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`).map((call) => call.body)).toEqual([{ accountIds: [ADA] }]);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Edit Platform" })).toBeNull();
    });

    const second = await openEdit("Platform");
    await typeInto(within(second).getByRole("textbox", { name: "Description" }), "Runs it all");
    await press(within(second).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(calls("PATCH", `${TEAMS_PATH}/${PLATFORM}`)).toHaveLength(1);
    });
    expect(calls("PATCH", `${TEAMS_PATH}/${PLATFORM}`)[0]?.ifMatch).toBe('"1"');
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`)).toHaveLength(1);
  });

  it("shows a name another team has at the field and sends no members", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    await openTable();
    const dialog = await openEdit("Platform");

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "design");
    await press(within(dialog).getByRole("button", { name: "Remove Grace Hopper" }));
    await press(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(await within(dialog).findByText("The workspace already has a team with this name.")).toBeTruthy();
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`)).toHaveLength(0);
    expect(screen.queryByText("The change was not saved")).toBeNull();
  });

  it("refuses to overwrite a team that was changed elsewhere", async () => {
    world.teams = [PLATFORM_TEAM()];
    await openTable();
    const dialog = await openEdit("Platform");
    // Another client renames it after this form read it.
    const stored = world.teams[0];
    if (stored !== undefined) {
      stored.version = 2;
    }

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Platform team");
    await press(within(dialog).getByRole("button", { name: "Save changes" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("This team was changed somewhere else.");
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`)).toHaveLength(0);
    expect(world.teams[0]?.name).toBe("Platform");
  });

  it("keeps the name it saved when the members step fails, and a second try sends only the members", async () => {
    world.teams = [PLATFORM_TEAM()];
    world.refuse.set("replaceTeamMembers", (call) => (call === 1 ? problem(503, "unavailable", "req-503") : undefined));
    await openTable();
    const dialog = await openEdit("Platform");

    await typeInto(within(dialog).getByRole("textbox", { name: "Name" }), "Platform team");
    await press(within(dialog).getByRole("button", { name: "Remove Grace Hopper" }));
    await press(within(dialog).getByRole("button", { name: "Save changes" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Some of your changes were saved, but not all of them.");
    expect(screen.queryByText("Team saved.")).toBeNull();

    await press(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Team saved.")).toBeTruthy();
    expect(calls("PATCH", `${TEAMS_PATH}/${PLATFORM}`)).toHaveLength(1);
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`).map((call) => call.body)).toEqual([{ accountIds: [ADA] }, { accountIds: [ADA] }]);
  });

  it("says in the form that someone chosen is no longer a member", async () => {
    world.teams = [PLATFORM_TEAM()];
    world.refuse.set("replaceTeamMembers", () =>
      json(
        { type: "https://slugbase.app/problems/validation_failed", title: "x", status: 422, code: "validation_failed", detail: "x", requestId: "req-422", errors: [{ path: "accountIds", code: "not_a_member" }] },
        { status: 422, contentType: "application/problem+json" },
      ),
    );
    await openTable();
    const dialog = await openEdit("Platform");

    await press(within(dialog).getByRole("button", { name: "Remove Grace Hopper" }));
    await press(within(dialog).getByRole("button", { name: "Save changes" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Someone you chose is no longer a member of this workspace.");
    expect(screen.queryByText("The change was not saved")).toBeNull();
  });

  it("says the team could not be loaded for an edit instead of showing an empty form, and loads it again on retry", async () => {
    world.teams = [PLATFORM_TEAM()];
    await openTable();
    await within(rowOf("Platform")).findByRole("img");
    let failing = true;
    world.refuse.set("getTeam", () => (failing ? problem(503, "unavailable", "req-503") : undefined));
    await chooseAction("Platform", "Edit");
    const dialog = await screen.findByRole("dialog", { name: "Edit Platform" });

    expect(await within(dialog).findByText("The team could not be loaded.", undefined, { timeout: 8000 })).toBeTruthy();
    expect(within(dialog).queryByRole("textbox", { name: "Name" })).toBeNull();
    failing = false;
    await press(within(dialog).getByRole("button", { name: "Try again" }));

    expect((await within(dialog).findByRole<HTMLInputElement>("textbox", { name: "Name" })).value).toBe("Platform");
  });
});

describe("deleting a team", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks first and says that what was shared through the team ends", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    await openTable();

    await chooseAction("Platform", "Delete");

    const dialog = await screen.findByRole("alertdialog", { name: "Delete “Platform”?" });
    expect(dialog.textContent).toContain("Everything shared through the team “Platform” stops being shared with its members.");
    expect(dialog.textContent).toContain("The members stay in the workspace.");
    expect(calls("DELETE", `${TEAMS_PATH}/${PLATFORM}`)).toHaveLength(0);
    await press(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(calls("DELETE", `${TEAMS_PATH}/${PLATFORM}`)).toHaveLength(0);
    expect(within(screen.getByRole("table", { name: "Teams" })).getByText("Platform")).toBeTruthy();
  });

  it("deletes the team once it is confirmed and takes it off the list", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    await openTable();
    await chooseAction("Platform", "Delete");
    const dialog = await screen.findByRole("alertdialog", { name: "Delete “Platform”?" });

    await press(within(dialog).getByRole("button", { name: "Delete team" }));

    expect(await screen.findByText("Team “Platform” deleted.")).toBeTruthy();
    expect(calls("DELETE", `${TEAMS_PATH}/${PLATFORM}`)).toHaveLength(1);
    await waitFor(() => {
      expect(within(screen.getByRole("table", { name: "Teams" })).queryByText("Platform")).toBeNull();
    });
    expect(within(screen.getByRole("table", { name: "Teams" })).getByText("Design")).toBeTruthy();
  });

  it("tells a team that is gone already apart from a failure, and reads the list again", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    await openTable();
    await chooseAction("Platform", "Delete");
    const dialog = await screen.findByRole("alertdialog", { name: "Delete “Platform”?" });
    // Another admin deletes it first.
    world.teams = world.teams.filter((stored) => stored.id !== PLATFORM);

    await press(within(dialog).getByRole("button", { name: "Delete team" }));

    expect(await screen.findByText("This team was already deleted.")).toBeTruthy();
    expect(screen.queryByText("The change was not saved")).toBeNull();
    await waitFor(() => {
      expect(within(screen.getByRole("table", { name: "Teams" })).queryByText("Platform")).toBeNull();
    });
  });

  it("keeps the confirmation open and reports a failure, leaving the team in the list", async () => {
    world.teams = [PLATFORM_TEAM()];
    world.refuse.set("deleteTeam", () => problem(503, "unavailable", "req-delete"));
    await openTable();
    await chooseAction("Platform", "Delete");
    const dialog = await screen.findByRole("alertdialog", { name: "Delete “Platform”?" });

    await press(within(dialog).getByRole("button", { name: "Delete team" }));

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(screen.getByRole("alertdialog", { name: "Delete “Platform”?" })).toBeTruthy();
    expect(world.teams).toHaveLength(1);
  });
});
