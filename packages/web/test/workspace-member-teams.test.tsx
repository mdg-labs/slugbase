import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, WORKSPACE_ID, WORKSPACE_LIST_BODY, allowSlowRender, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The teams of the members of /settings/workspace/members (doc 03 section 11.7, doc 02 sections 3.4 and 4) against the handlers generated
// from openapi.json, with teams kept the way the API keeps them. The failure scenarios are a teams column that shows another member's
// teams or none for a member who has some, a Manage teams that is offered without the teams.manage entitlement, a change that overwrites
// what another admin put into a team since the page was read (the team is not read again first), a change whose k-th request fails
// and is shown as saved or loses the steps that went through, a list of teams that failed shown as "no team matches", an invitation that
// sends teams the dialog did not show, and an invitation whose team is gone shown as sent.

const server = createMockServer();
const document_ = readOpenApiDocument();

const ADA = ACCOUNT_BODY.id;
const GRACE = "0192f3a0-bbbb-7000-8000-000000000002";
const ALAN = "0192f3a0-bbbb-7000-8000-000000000003";
const PLATFORM = "0192f3a0-ffff-7000-8000-000000000001";
const DESIGN = "0192f3a0-ffff-7000-8000-000000000002";
const SUPPORT = "0192f3a0-ffff-7000-8000-000000000003";
const TEAMS_PATH = "/api/v1/teams";
const INVITATIONS_PATH = "/api/v1/invitations";
const STAMP = "2026-10-01T08:00:00.000Z";

interface StoredTeam {
  id: string;
  name: string;
  memberIds: string[];
  version: number;
}

const PEOPLE = [
  { accountId: ADA, displayName: "Ada Lovelace", email: "ada@example.org" },
  { accountId: GRACE, displayName: "Grace Hopper", email: "grace@example.org" },
  { accountId: ALAN, displayName: "Alan Turing", email: "alan@example.org" },
] as const;

interface Received {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly ifMatch: string | null;
}

interface World {
  teams: StoredTeam[];
  teamsManage: boolean;
  received: Received[];
  refuse: Map<string, (call: number) => Response | undefined | Promise<Response | undefined>>;
  calls: Map<string, number>;
}

let world: World;

function newWorld(): World {
  return { teams: [], teamsManage: true, received: [], refuse: new Map(), calls: new Map() };
}

function team(id: string, name: string, memberIds: string[]): StoredTeam {
  return { id, name, memberIds, version: 1 };
}

function listed(stored: StoredTeam) {
  return { id: stored.id, name: stored.name, description: "", memberCount: stored.memberIds.length, version: stored.version, createdAt: STAMP, updatedAt: STAMP };
}

function detailed(stored: StoredTeam) {
  return {
    ...listed(stored),
    members: PEOPLE.filter(({ accountId }) => stored.memberIds.includes(accountId)).map(({ accountId, displayName, email }) => ({ accountId, displayName, email })),
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
      "teams.manage": world.teamsManage,
      "audit.log": true,
    },
    usage: { "bookmarks.used": 0, "seats.used": 3, "workspaces.owned": 1 },
    upgradeAvailable: true,
  };
}

function steered(operationId: string): Response | undefined | Promise<Response | undefined> {
  const call = (world.calls.get(operationId) ?? 0) + 1;
  world.calls.set(operationId, call);
  return world.refuse.get(operationId)?.(call);
}

function record(request: Request, body: unknown): void {
  world.received.push({ method: request.method, path: new URL(request.url).pathname, body, ifMatch: request.headers.get("if-match") });
}

function teamOf(url: string): StoredTeam | undefined {
  const id = new URL(url).pathname.split("/")[4];
  return world.teams.find((candidate) => candidate.id === id);
}

function memberBody(person: (typeof PEOPLE)[number]) {
  return {
    ...person,
    role: "member",
    joinedAt: STAMP,
    lastActiveAt: null,
    teams: world.teams
      .filter((stored) => stored.memberIds.includes(person.accountId))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ id, name }) => ({ id, name })),
  };
}

function serve(): void {
  server.use(
    ...createResolverHandlers(document_, {
      getMe: () =>
        json({
          account: ACCOUNT_BODY,
          memberships: [{ workspaceId: WORKSPACE_ID, name: "Ada's Workspace", role: "owner" }],
          activeWorkspaceId: WORKSPACE_ID,
        }),
      getWorkspace: () =>
        json({ id: WORKSPACE_ID, name: "Ada's Workspace", role: "owner", memberCount: 3, createdAt: STAMP, version: 1 }, { headers: { ETag: '"1"' } }),
      getEntitlements: () => json(entitlementsBody()),
      listMembers: () => json({ items: PEOPLE.map(memberBody), nextCursor: null }),
      listInvitations: () => json({ items: [], nextCursor: null }),
      createInvitation: async (request) => {
        const body = (await request.json()) as { email: string; role: string; teamIds?: string[] };
        record(request, body);
        const steer = await steered("createInvitation");
        if (steer !== undefined) {
          return steer;
        }
        return json(
          {
            id: "0192f3a0-dddd-7000-8000-000000000001",
            email: body.email,
            role: body.role,
            teamIds: body.teamIds ?? [],
            status: "pending",
            invitedBy: ADA,
            expiresAt: "2026-12-01T10:00:00.000Z",
            createdAt: STAMP,
          },
          { status: 201 },
        );
      },
      listTeams: async (request) => {
        record(request, undefined);
        return (await steered("listTeams")) ?? json({ items: [...world.teams].sort((a, b) => a.name.localeCompare(b.name)).map(listed), nextCursor: null });
      },
      getTeam: async (request) => {
        record(request, undefined);
        const found = teamOf(request.url);
        return (await steered("getTeam")) ?? (found === undefined ? problem(404, "not_found", "req-404") : json(detailed(found), { headers: { ETag: `"${String(found.version)}"` } }));
      },
      replaceTeamMembers: async (request) => {
        const body = (await request.json()) as { accountIds: string[] };
        record(request, body);
        const steer = await steered("replaceTeamMembers");
        if (steer !== undefined) {
          return steer;
        }
        const found = teamOf(request.url);
        if (found === undefined) {
          return problem(404, "not_found", "req-404");
        }
        const ifMatch = request.headers.get("if-match");
        if (ifMatch !== null && ifMatch !== `"${String(found.version)}"`) {
          return problem(412, "precondition_failed", "req-412");
        }
        const next = [...new Set(body.accountIds)];
        if (next.length !== found.memberIds.length || next.some((id) => !found.memberIds.includes(id))) {
          found.version += 1;
        }
        found.memberIds = next;
        return json(detailed(found), { headers: { ETag: `"${String(found.version)}"` } });
      },
    }),
    ...createHandlers(document_, { scenario: { name: "member-teams", fixtures: { listWorkspaces: WORKSPACE_LIST_BODY } } }),
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

async function openMembers(): Promise<HTMLElement> {
  serve();
  window.history.replaceState(null, "", "/settings/workspace/members");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  return screen.findByRole("table", { name: "Members" });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table", { name: "Members" }))
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(name) !== null);
  if (row === undefined) {
    throw new Error(`no row for ${name}`);
  }
  return row;
}

async function openManage(name: string): Promise<HTMLElement> {
  await press(within(rowOf(name)).getByRole("button", { name: `Actions for ${name}` }));
  await press(await screen.findByRole("menuitem", { name: "Manage teams" }));
  const dialog = await screen.findByRole("dialog", { name: `Teams of ${name}` });
  return dialog;
}

async function openPicker(dialog: HTMLElement): Promise<HTMLElement> {
  const input = await within(dialog).findByLabelText("Teams");
  await act(async () => {
    fireEvent.pointerDown(input);
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    await Promise.resolve();
  });
  return input;
}

async function chooseTeam(dialog: HTMLElement, name: string): Promise<void> {
  const input = await openPicker(dialog);
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

const PLATFORM_TEAM = (): StoredTeam => team(PLATFORM, "Platform", [ADA, GRACE]);
const DESIGN_TEAM = (): StoredTeam => team(DESIGN, "Design", [GRACE, ALAN]);
const SUPPORT_TEAM = (): StoredTeam => team(SUPPORT, "Support", []);

describe("the teams column", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows each member's own teams as badges by name, and says so for a member without one", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    await openMembers();

    const teamsOf = (name: string): (string | null)[] =>
      within(within(rowOf(name)).getAllByRole("cell")[3] ?? rowOf(name))
        .queryAllByRole("listitem")
        .map((item) => item.textContent);
    expect(teamsOf("Grace Hopper")).toEqual(["Design", "Platform"]);
    expect(teamsOf("Ada Lovelace")).toEqual(["Platform"]);
    expect(teamsOf("Alan Turing")).toEqual(["Design"]);
  });

  it("says No teams for a member in none", async () => {
    world.teams = [DESIGN_TEAM()];
    await openMembers();

    expect(within(within(rowOf("Ada Lovelace")).getAllByRole("cell")[3] ?? rowOf("Ada Lovelace")).getByText("No teams")).toBeTruthy();
  });

  it("has no accessibility violations with teams shown", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    await openMembers();

    const results = await axe(document.body, { rules: { region: { enabled: false } } });

    expect(results.violations.map(({ id }) => id)).toEqual([]);
  });
});

describe("Manage teams", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is offered where the workspace holds teams.manage and not where it lacks it", async () => {
    world.teams = [PLATFORM_TEAM()];
    world.teamsManage = false;
    await openMembers();

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Actions for Grace Hopper" })).not.toBeNull();
    });
    await press(screen.getByRole("button", { name: "Actions for Grace Hopper" }));
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Manage teams" })).toBeNull();
    });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).not.toContain("Manage teams");
  });

  it("starts from the member's teams, offers every team of the workspace and sends nothing until saved", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM(), SUPPORT_TEAM()];
    await openMembers();

    const dialog = await openManage("Grace Hopper");

    expect(chips(dialog)).toEqual(["Design", "Platform"]);
    await openPicker(dialog);
    const options = (await screen.findAllByRole("option", { hidden: true })).map((option) => option.textContent);
    expect(options).toEqual(["Design", "Platform", "Support"]);
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`)).toHaveLength(0);
  });

  it("reads each team that changes again, and puts the member in or out of what the team holds now", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM(), SUPPORT_TEAM()];
    await openMembers();
    const dialog = await openManage("Grace Hopper");
    // Another admin puts Alan into Platform and Ada into Support after the page was read.
    const platform = world.teams.find((stored) => stored.id === PLATFORM);
    const support = world.teams.find((stored) => stored.id === SUPPORT);
    platform?.memberIds.push(ALAN);
    support?.memberIds.push(ADA);

    await press(within(dialog).getByRole("button", { name: "Remove Platform" }));
    await chooseTeam(dialog, "Support");
    await press(within(dialog).getByRole("button", { name: "Save teams" }));

    expect(await screen.findByText("Teams of Grace Hopper saved.")).toBeTruthy();
    const requests = world.received.filter((call) => call.path.startsWith(`${TEAMS_PATH}/`)).map((call) => `${call.method} ${call.path.slice(TEAMS_PATH.length + 1)}`);
    expect(requests).toEqual([`GET ${PLATFORM}`, `PUT ${PLATFORM}/members`, `GET ${SUPPORT}`, `PUT ${SUPPORT}/members`]);
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`).map((call) => call.body)).toEqual([{ accountIds: [ADA, ALAN] }]);
    expect(calls("PUT", `${TEAMS_PATH}/${SUPPORT}/members`).map((call) => call.body)).toEqual([{ accountIds: [ADA, GRACE] }]);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Teams of Grace Hopper" })).toBeNull();
    });
  });

  it("makes each replacement against the version of the read it was made from", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM(), SUPPORT_TEAM()];
    await openMembers();
    const dialog = await openManage("Grace Hopper");
    // Both teams were changed by other admins after the page was read, which moved their versions.
    const platform = world.teams.find((stored) => stored.id === PLATFORM);
    const support = world.teams.find((stored) => stored.id === SUPPORT);
    if (platform !== undefined) {
      platform.version = 3;
    }
    if (support !== undefined) {
      support.version = 7;
    }

    await press(within(dialog).getByRole("button", { name: "Remove Platform" }));
    await chooseTeam(dialog, "Support");
    await press(within(dialog).getByRole("button", { name: "Save teams" }));

    expect(await screen.findByText("Teams of Grace Hopper saved.")).toBeTruthy();
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`).map((call) => call.ifMatch)).toEqual(['"3"']);
    expect(calls("PUT", `${TEAMS_PATH}/${SUPPORT}/members`).map((call) => call.ifMatch)).toEqual(['"7"']);
  });

  it("shows a conflict and overwrites nothing when a team changed between its read and the replacement, and a second try applies to the latest members", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    const platform = world.teams[0];
    // Another admin puts Alan into Platform after the team was read and before the replacement is sent.
    world.refuse.set("replaceTeamMembers", (call) => {
      if (call === 1 && platform !== undefined) {
        platform.memberIds.push(ALAN);
        platform.version += 1;
      }
      return undefined;
    });
    await openMembers();
    const dialog = await openManage("Grace Hopper");

    await press(within(dialog).getByRole("button", { name: "Remove Platform" }));
    await press(within(dialog).getByRole("button", { name: "Save teams" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("A team was changed somewhere else, so nothing in it was overwritten.");
    expect(screen.queryByText("Teams of Grace Hopper saved.")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Teams of Grace Hopper" })).toBeTruthy();
    expect(platform?.memberIds).toEqual([ADA, GRACE, ALAN]);

    await press(within(dialog).getByRole("button", { name: "Save teams" }));

    expect(await screen.findByText("Teams of Grace Hopper saved.")).toBeTruthy();
    expect(platform?.memberIds).toEqual([ADA, ALAN]);
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`).map((call) => call.ifMatch)).toEqual(['"1"', '"2"']);
  });

  it("sends nothing for a team that is unchanged, and reads and writes only the ones that are not", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM(), SUPPORT_TEAM()];
    await openMembers();
    const dialog = await openManage("Grace Hopper");

    await press(within(dialog).getByRole("button", { name: "Save teams" }));

    expect(await screen.findByText("Teams of Grace Hopper saved.")).toBeTruthy();
    expect(world.received.filter((call) => call.path.startsWith(`${TEAMS_PATH}/`))).toEqual([]);
  });

  it("keeps the steps that went through when a later one fails, says so, and a second try sends only the rest", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM(), SUPPORT_TEAM()];
    world.refuse.set("replaceTeamMembers", (call) => (call === 2 ? problem(503, "unavailable", "req-503") : undefined));
    await openMembers();
    const dialog = await openManage("Grace Hopper");

    await press(within(dialog).getByRole("button", { name: "Remove Platform" }));
    await chooseTeam(dialog, "Support");
    await press(within(dialog).getByRole("button", { name: "Save teams" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Some of your changes were saved, but not all of them.");
    expect(screen.queryByText("Teams of Grace Hopper saved.")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Teams of Grace Hopper" })).toBeTruthy();
    // Platform was left; the table behind the dialog has been read again and no longer lists it for Grace.
    await waitFor(() => {
      // The dialog is modal, so the page behind it is hidden from the accessibility tree.
      const row = within(screen.getByRole("table", { name: "Members", hidden: true }))
        .getAllByRole("row", { hidden: true })
        .find((candidate) => within(candidate).queryByText("Grace Hopper") !== null);
      expect(within(row ?? document.body).queryByText("Platform")).toBeNull();
      expect(within(row ?? document.body).getByText("Design")).toBeTruthy();
    });

    await press(within(dialog).getByRole("button", { name: "Save teams" }));

    expect(await screen.findByText("Teams of Grace Hopper saved.")).toBeTruthy();
    const requests = world.received.filter((call) => call.path.startsWith(`${TEAMS_PATH}/`)).map((call) => `${call.method} ${call.path.slice(TEAMS_PATH.length + 1)}`);
    expect(requests).toEqual([`GET ${PLATFORM}`, `PUT ${PLATFORM}/members`, `GET ${SUPPORT}`, `PUT ${SUPPORT}/members`, `GET ${SUPPORT}`, `PUT ${SUPPORT}/members`]);
    expect(world.teams.find((stored) => stored.id === SUPPORT)?.memberIds).toEqual([GRACE]);
    expect(world.teams.find((stored) => stored.id === PLATFORM)?.memberIds).toEqual([ADA]);
  });

  it("leaves a team that is gone already without a failure, and says a team to join that is gone no longer exists", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM(), SUPPORT_TEAM()];
    await openMembers();
    const dialog = await openManage("Grace Hopper");
    // Platform is deleted elsewhere after the page was read.
    world.teams = world.teams.filter((stored) => stored.id !== PLATFORM);

    await press(within(dialog).getByRole("button", { name: "Remove Platform" }));
    await press(within(dialog).getByRole("button", { name: "Save teams" }));
    expect(await screen.findByText("Teams of Grace Hopper saved.")).toBeTruthy();
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`)).toHaveLength(0);

    const again = await openManage("Grace Hopper");
    world.teams = world.teams.filter((stored) => stored.id !== SUPPORT);
    await chooseTeam(again, "Support");
    await press(within(again).getByRole("button", { name: "Save teams" }));

    expect((await within(again).findByRole("alert")).textContent).toContain("A team you chose no longer exists.");
    expect(screen.getAllByText("Teams of Grace Hopper saved.")).toHaveLength(1);
  });

  const UNKNOWN_MEMBER = () =>
    json(
      { type: "https://slugbase.app/problems/validation_failed", title: "x", status: 422, code: "validation_failed", detail: "x", requestId: "req-422", errors: [{ path: "accountIds", code: "unknown_member" }] },
      { status: 422, contentType: "application/problem+json" },
    );

  it("says in the dialog that the person is no longer a member when a team they are added to still refuses them after it was read again", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM(), SUPPORT_TEAM()];
    world.refuse.set("replaceTeamMembers", UNKNOWN_MEMBER);
    await openMembers();
    const dialog = await openManage("Grace Hopper");

    await chooseTeam(dialog, "Support");
    await press(within(dialog).getByRole("button", { name: "Save teams" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("This person is no longer a member of this workspace.");
    expect(screen.queryByText("That did not work", { exact: false })).toBeNull();
    expect(calls("GET", `${TEAMS_PATH}/${SUPPORT}`)).toHaveLength(2);
    expect(calls("PUT", `${TEAMS_PATH}/${SUPPORT}/members`)).toHaveLength(2);
  });

  it("does not blame the person being edited when another member of the team they are taken out of has left the workspace", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    world.refuse.set("replaceTeamMembers", UNKNOWN_MEMBER);
    await openMembers();
    const dialog = await openManage("Grace Hopper");

    await press(within(dialog).getByRole("button", { name: "Remove Platform" }));
    await press(within(dialog).getByRole("button", { name: "Save teams" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("A team was changed somewhere else");
    expect(alert.textContent).not.toContain("This person is no longer a member");
    expect(world.teams.find((stored) => stored.id === PLATFORM)?.memberIds).toEqual([ADA, GRACE]);
  });

  it("reads the team again once when another member left after the read, and then makes the change", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    const platform = world.teams[0];
    // Ada leaves the workspace after the team was read: the first replacement is refused, the team no longer holds her.
    world.refuse.set("replaceTeamMembers", (call) => {
      if (call === 1 && platform !== undefined) {
        platform.memberIds = platform.memberIds.filter((id) => id !== ADA);
        platform.version += 1;
        return UNKNOWN_MEMBER();
      }
      return undefined;
    });
    await openMembers();
    const dialog = await openManage("Grace Hopper");

    await press(within(dialog).getByRole("button", { name: "Remove Platform" }));
    await press(within(dialog).getByRole("button", { name: "Save teams" }));

    expect(await screen.findByText("Teams of Grace Hopper saved.")).toBeTruthy();
    expect(calls("PUT", `${TEAMS_PATH}/${PLATFORM}/members`).map((call) => call.body)).toEqual([{ accountIds: [ADA] }, { accountIds: [] }]);
    expect(platform?.memberIds).toEqual([]);
  });

  it("shows a wait while the teams load, and says they could not be loaded instead of saying no team matches", async () => {
    world.teams = [PLATFORM_TEAM()];
    await openMembers();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.refuse.set("listTeams", async () => {
      await gate;
      return problem(503, "unavailable", "req-503");
    });

    const dialog = await openManage("Grace Hopper");
    await openPicker(dialog);
    expect(await screen.findByText("Loading teams")).toBeTruthy();
    expect(screen.queryByText("No team matches.", { exact: false })).toBeNull();
    await act(async () => {
      release();
      await gate;
    });

    expect(await screen.findByText("The teams could not be loaded.", undefined, { timeout: 8000 })).toBeTruthy();
    expect(screen.queryByText("No team matches.", { exact: false })).toBeNull();
  });

  it("says no team matches where the workspace has none", async () => {
    await openMembers();
    const dialog = await openManage("Grace Hopper");

    await openPicker(dialog);

    expect(await screen.findByText("No team matches.", { exact: false })).toBeTruthy();
  });

  it("has no accessibility violations", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    await openMembers();
    const dialog = await openManage("Grace Hopper");
    await within(dialog).findByLabelText("Teams");

    const results = await axe(document.body, { rules: { region: { enabled: false } } });

    expect(results.violations.map(({ id }) => id)).toEqual([]);
  });
});

async function openInvite(): Promise<HTMLElement> {
  await openMembers();
  await press(await screen.findByRole("button", { name: "Invite people" }));
  return screen.findByRole("dialog", { name: "Invite people" });
}

async function typeAddress(dialog: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Email addresses" }), { target: { value: text } });
    await Promise.resolve();
  });
}

describe("the invite dialog", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("sends the teams it shows chosen with each invitation, and none when none are chosen", async () => {
    world.teams = [PLATFORM_TEAM(), DESIGN_TEAM()];
    const dialog = await openInvite();

    await typeAddress(dialog, "linus@example.org, tim@example.org");
    await chooseTeam(dialog, "Platform");
    await chooseTeam(dialog, "Design");
    expect(chips(dialog)).toEqual(["Platform", "Design"]);
    await press(within(dialog).getByRole("button", { name: "Send invitations" }));

    expect(await screen.findByText("2 of 2 invited.")).toBeTruthy();
    expect(calls("POST", INVITATIONS_PATH).map((call) => call.body)).toEqual([
      { email: "linus@example.org", role: "member", teamIds: [PLATFORM, DESIGN] },
      { email: "tim@example.org", role: "member", teamIds: [PLATFORM, DESIGN] },
    ]);
  });

  it("sends an empty list of teams where none is chosen", async () => {
    world.teams = [PLATFORM_TEAM()];
    const dialog = await openInvite();

    await typeAddress(dialog, "linus@example.org");
    await press(within(dialog).getByRole("button", { name: "Send invitations" }));

    expect(await screen.findByText("1 of 1 invited.")).toBeTruthy();
    expect(calls("POST", INVITATIONS_PATH).map((call) => call.body)).toEqual([{ email: "linus@example.org", role: "member", teamIds: [] }]);
  });

  it("says a team that is gone no longer exists instead of reporting the address as invalid, and reads the teams again", async () => {
    world.teams = [PLATFORM_TEAM()];
    world.refuse.set("createInvitation", () =>
      json(
        { type: "https://slugbase.app/problems/validation_failed", title: "x", status: 422, code: "validation_failed", detail: "x", requestId: "req-422", errors: [{ path: "teamIds", code: "unknown_team" }] },
        { status: 422, contentType: "application/problem+json" },
      ),
    );
    const dialog = await openInvite();

    await typeAddress(dialog, "linus@example.org");
    await chooseTeam(dialog, "Platform");
    const lists = calls("GET", TEAMS_PATH).length;
    await press(within(dialog).getByRole("button", { name: "Send invitations" }));

    expect(await screen.findByText("A team you chose no longer exists. Go back, remove it and try again.", { exact: false })).toBeTruthy();
    expect(screen.queryByText("Not a valid email address.")).toBeNull();
    expect(screen.getByText("0 of 1 invited.")).toBeTruthy();
    await waitFor(() => {
      expect(calls("GET", TEAMS_PATH).length).toBeGreaterThan(lists);
    });
  });

  it("shows a wait while the teams load and says so where there are none", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.refuse.set("listTeams", async () => {
      await gate;
      return undefined;
    });
    const dialog = await openInvite();

    await openPicker(dialog);
    expect(await screen.findByText("Loading teams")).toBeTruthy();
    await act(async () => {
      release();
      await gate;
    });

    expect(await screen.findByText("No team matches.")).toBeTruthy();
  });

  it("has no accessibility violations", async () => {
    world.teams = [PLATFORM_TEAM()];
    const dialog = await openInvite();
    await within(dialog).findByLabelText("Teams");

    const results = await axe(document.body, { rules: { region: { enabled: false } } });

    expect(results.violations.map(({ id }) => id)).toEqual([]);
  });
});
