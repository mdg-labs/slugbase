import type { EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, MEMBERS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET and POST /api/v1/teams, GET, PATCH and DELETE /api/v1/teams/{id} and PUT /api/v1/teams/{id}/members (doc 04 sections 2.4 and 10.5, doc 02
// section 4, doc 05 section 2.3, doc 10 T1, T2 and T11), through the whole chain over the migrated database. The failure scenario: a plain
// member calls every operation that changes a team and gets 403, a token cannot reach them, a workspace without `teams.manage` is refused with
// `entitlement_required`, and an admin of workspace A who addresses a team of workspace B gets 404 and changes nothing. Besides that: every
// member lists the teams and reads their members; a name is 1 to 64 characters, stored as entered and unique without regard to case (409
// name_taken); a description is 0 to 280; the member set is replaced by current members of the workspace only (422 otherwise); a team and its
// memberships go together, and a member who leaves takes the membership with them; each change is audited with names only.

const TEST_TIMEOUT_MS = 60_000;
const TEAMS = "/api/v1/teams";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "teams.manage";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
});

interface Problem {
  readonly code: string;
  readonly status: number;
  readonly entitlement?: string;
  readonly errors?: readonly { readonly path: string; readonly code: string }[];
}

interface Member {
  readonly accountId: string;
  readonly displayName: string;
  readonly email: string;
}

interface Team {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly memberCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly members?: readonly Member[];
}

interface TeamList {
  readonly items: readonly Team[];
  readonly nextCursor: string | null;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const create = (world: World, as: Person, body: unknown) => send(world, "POST", TEAMS, { cookie: as.cookie }, body);
const list = (world: World, as: Person, query = "") => send(world, "GET", `${TEAMS}${query}`, { cookie: as.cookie });
const read = (world: World, as: Person, id: string) => send(world, "GET", `${TEAMS}/${id}`, { cookie: as.cookie });
const patch = (world: World, as: Person, id: string, body: unknown, headers: Record<string, string> = {}) => send(world, "PATCH", `${TEAMS}/${id}`, { cookie: as.cookie, ...headers }, body);
const remove = (world: World, as: Person, id: string) => send(world, "DELETE", `${TEAMS}/${id}`, { cookie: as.cookie });
const replace = (world: World, as: Person, id: string, accountIds: readonly string[], headers: Record<string, string> = {}) =>
  send(world, "PUT", `${TEAMS}/${id}/members`, { cookie: as.cookie, ...headers }, { accountIds });

async function created(world: World, as: Person, body: { name: string; description?: string }): Promise<Team> {
  const response = await create(world, as, body);
  expect(response.status).toBe(201);
  return (await response.json()) as Team;
}

interface StoredTeam {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  version: number;
}

async function storedTeams(): Promise<StoredTeam[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<StoredTeam[]>`SELECT id, workspace_id, name::text AS name, description, version FROM teams ORDER BY name, id`;
  });
}

async function storedMemberships(teamId: string): Promise<string[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ account_id: string }[]>`SELECT account_id FROM team_members WHERE team_id = ${teamId} ORDER BY account_id`;
  });
  return rows.map((row) => row.account_id);
}

interface AuditRow {
  action: string;
  actor_type: string;
  actor_account_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
}

async function auditOf(workspaceId: string): Promise<AuditRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AuditRow[]>`
      SELECT action, actor_type, actor_account_id, entity_type, entity_id, metadata
      FROM audit_events WHERE workspace_id = ${workspaceId} AND action LIKE 'team.%' ORDER BY created_at, id`;
  });
  return [...rows];
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

/** Workspace A with an owner, an admin and two plain members, and workspace B of a stranger who owns a team there. */
async function setup(world: World) {
  const owner = await harness.person(world);
  const admin = await harness.person(world);
  const member = await harness.person(world);
  const other = await harness.person(world);
  const stranger = await harness.person(world);
  const a = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: admin, role: "admin" },
    { person: member, role: "member" },
    { person: other, role: "member" },
  ]);
  const b = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  const teamOfB = await created(world, stranger, { name: "Team of B", description: "B only" });
  expect(await replace(world, stranger, teamOfB.id, [stranger.account.id])).toMatchObject({ status: 200 });
  return { owner, admin, member, other, stranger, a, b, teamOfB };
}

describe("the failure scenario", () => {
  it(
    "answers 403 to a plain member on every operation that changes a team, and changes nothing",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, member, a } = await setup(world);
      const team = await created(world, owner, { name: "Design" });
      const before = await storedTeams();

      const responses = [
        await create(world, member, { name: "Planted" }),
        await patch(world, member, team.id, { name: "Hijacked" }),
        await remove(world, member, team.id),
        await replace(world, member, team.id, [member.account.id]),
      ];

      expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
      for (const response of responses) {
        expect((await problemOf(response)).code).toBe("forbidden");
      }
      expect(await storedTeams()).toEqual(before);
      expect(await storedMemberships(team.id)).toEqual([]);
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["team.created"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 to an admin of workspace A who addresses a team of workspace B, on every operation that names one, and changes nothing",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { admin, owner, teamOfB, stranger, b } = await setup(world);
      const before = await storedTeams();
      const membersBefore = await storedMemberships(teamOfB.id);
      expect(membersBefore).toEqual([stranger.account.id]);

      for (const as of [admin, owner]) {
        const responses = [
          await read(world, as, teamOfB.id),
          await patch(world, as, teamOfB.id, { name: "Hijacked", description: "mine" }),
          await remove(world, as, teamOfB.id),
          await replace(world, as, teamOfB.id, [as.account.id]),
          await replace(world, as, teamOfB.id, []),
        ];
        expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
        for (const response of responses) {
          expect((await problemOf(response)).code).toBe("not_found");
        }
      }

      const listed = (await (await list(world, admin)).json()) as TeamList;
      expect(listed.items.map((team) => team.id)).not.toContain(teamOfB.id);
      expect(await storedTeams()).toEqual(before);
      expect(await storedMemberships(teamOfB.id)).toEqual(membersBefore);
      expect(await auditOf(b.workspaceId)).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers the same 404 for a team that does not exist",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { admin } = await setup(world);
      const unknown = crypto.randomUUID();
      const responses = [
        await read(world, admin, unknown),
        await patch(world, admin, unknown, { name: "Ghost" }),
        await remove(world, admin, unknown),
        await replace(world, admin, unknown, []),
      ];
      expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the entitlement teams.manage", () => {
  it(
    "is enforced on the server: a workspace without it is refused entitlement_required on every operation that changes a team, an owner included, and nothing is written",
    async () => {
      const closed = harness.serve();
      const refusing = harness.serve({ entitlements: () => false });
      const granted = harness.serve({ entitlements: GRANTED });
      const { owner, admin, a } = await setup(granted);
      const team = await created(granted, owner, { name: "Design" });
      const before = await storedTeams();

      for (const world of [closed, refusing]) {
        for (const as of [owner, admin]) {
          const responses = [
            await create(world, as, { name: "Planted" }),
            await patch(world, as, team.id, { name: "Hijacked" }),
            await remove(world, as, team.id),
            await replace(world, as, team.id, [as.account.id]),
          ];
          expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
          for (const response of responses) {
            const refusal = await problemOf(response);
            expect(refusal.code).toBe("entitlement_required");
            expect(refusal.entitlement).toBe("teams.manage");
          }
        }
      }

      expect(await storedTeams()).toEqual(before);
      expect(await storedMemberships(team.id)).toEqual([]);
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["team.created"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not gate the two reads: every member still lists the teams and reads one without it",
    async () => {
      const granted = harness.serve({ entitlements: GRANTED });
      const refusing = harness.serve({ entitlements: () => false });
      const { owner, member } = await setup(granted);
      const team = await created(granted, owner, { name: "Design" });

      expect((await list(refusing, member)).status).toBe(200);
      expect((await read(refusing, member, team.id)).status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("who calls", () => {
  it(
    "lets an API token read the teams with the read scope and never change them, and refuses the anonymous caller",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { admin, owner, a } = await setup(world);
      const team = await created(world, owner, { name: "Design" });
      const readToken = await harness.token(a.workspaceId, admin, "read");
      const writeToken = await harness.token(a.workspaceId, admin, "read-write");

      expect((await send(world, "GET", TEAMS, bearer(readToken))).status).toBe(200);
      expect((await send(world, "GET", `${TEAMS}/${team.id}`, bearer(readToken))).status).toBe(200);
      for (const token of [readToken, writeToken]) {
        expect((await send(world, "POST", TEAMS, bearer(token), { name: "Planted" })).status).toBe(403);
        expect((await send(world, "PATCH", `${TEAMS}/${team.id}`, bearer(token), { name: "Hijacked" })).status).toBe(403);
        expect((await send(world, "DELETE", `${TEAMS}/${team.id}`, bearer(token))).status).toBe(403);
        expect((await send(world, "PUT", `${TEAMS}/${team.id}/members`, bearer(token), { accountIds: [] })).status).toBe(403);
      }
      expect((await send(world, "GET", TEAMS, {})).status).toBe(401);
      expect((await send(world, "POST", TEAMS, {}, { name: "Anonymous" })).status).toBe(401);
      expect((await storedTeams()).map((stored) => stored.name)).toEqual(["Design", "Team of B"]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("createTeam", () => {
  it(
    "answers 201 with the team as entered, no members, version 1 and its ETag, stores it in the workspace of the request and records team.created with the name only",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { admin, a } = await setup(world);

      const response = await create(world, admin, { name: "  Design Team  ", description: "  Makes the pictures  " });

      expect(response.status).toBe(201);
      expect(response.headers.get("etag")).toBe('"1"');
      const team = (await response.json()) as Team;
      expect(team).toEqual({ id: team.id, name: "Design Team", description: "Makes the pictures", memberCount: 0, version: 1, createdAt: team.createdAt, updatedAt: team.updatedAt, members: [] });
      expect(new Date(team.createdAt).toISOString()).toBe(team.createdAt);
      expect((await storedTeams()).filter((stored) => stored.workspace_id === a.workspaceId)).toEqual([
        { id: team.id, workspace_id: a.workspaceId, name: "Design Team", description: "Makes the pictures", version: 1 },
      ]);
      expect(await auditOf(a.workspaceId)).toEqual([
        { action: "team.created", actor_type: "account", actor_account_id: admin.account.id, entity_type: "team", entity_id: team.id, metadata: { name: "Design Team" } },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves the description empty when it is left out and accepts the limits: 64 characters of name and 280 of description",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner } = await setup(world);
      expect(await created(world, owner, { name: "Plain" })).toMatchObject({ description: "" });
      expect(await created(world, owner, { name: "n".repeat(64), description: "d".repeat(280) })).toMatchObject({ name: "n".repeat(64), description: "d".repeat(280) });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 409 name_taken for a name the workspace has in any case, writing nothing, and lets another workspace use the name",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin, stranger, a } = await setup(world);
      await created(world, owner, { name: "Design" });

      for (const name of ["Design", "design", "DESIGN", " Design "]) {
        for (const as of [owner, admin]) {
          const refused = await create(world, as, { name });
          expect(refused.status).toBe(409);
          const problem = await problemOf(refused);
          expect(problem.code).toBe("name_taken");
          expect(problem.errors).toEqual([{ path: "name", code: "name_taken" }]);
        }
      }
      expect((await storedTeams()).filter((stored) => stored.name.toLowerCase() === "design")).toHaveLength(1);
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["team.created"]);

      expect((await create(world, stranger, { name: "design" })).status).toBe(201);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "makes one team of the creations of one name at the same time and answers the others 409 name_taken",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin, a } = await setup(world);

      const responses = await Promise.all([owner, admin, owner, admin].map((as) => create(world, as, { name: "Race" })));

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409]);
      expect((await storedTeams()).filter((stored) => stored.name === "Race")).toHaveLength(1);
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["team.created"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 validation_failed for a name that is missing, blank or longer than 64 characters, a description longer than 280 and a field it does not declare, writing nothing",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, a } = await setup(world);
      const before = await storedTeams();

      for (const body of [{}, { name: "" }, { name: "   " }, { name: "n".repeat(65) }, { name: "ok", description: "d".repeat(281) }, { name: "ok", extra: true }, { name: 7 }, { name: "nul\u0000name" }, { name: "ok", description: "nul\u0000description" }]) {
        const response = await create(world, owner, body);
        expect(response.status).toBe(422);
        expect((await problemOf(response)).code).toBe("validation_failed");
      }
      expect(await storedTeams()).toEqual(before);
      expect(await auditOf(a.workspaceId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("listTeams", () => {
  it(
    "shows every member, a plain member included, every team of the workspace with its member count, in the order of name, and none of another workspace's",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, member, other, a } = await setup(world);
      const zeta = await created(world, owner, { name: "zeta" });
      const alpha = await created(world, owner, { name: "Alpha", description: "First" });
      await replace(world, owner, alpha.id, [member.account.id, other.account.id]);

      for (const as of [owner, member, other]) {
        const response = await list(world, as);
        expect(response.status).toBe(200);
        const body = (await response.json()) as TeamList;
        expect(body.items.map((team) => [team.name, team.memberCount, team.description])).toEqual([["Alpha", 2, "First"], ["zeta", 0, ""]]);
        expect(body.items.map((team) => team.id)).toEqual([alpha.id, zeta.id]);
        expect(body.items[0]).not.toHaveProperty("members");
        expect(body.nextCursor).toBeNull();
      }
      expect(a.workspaceId).not.toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "pages with a signed cursor that repeats and skips nothing, and refuses a cursor that is forged or was issued for another workspace",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, stranger } = await setup(world);
      for (const name of ["delta", "Alpha", "charlie", "Bravo", "echo"]) {
        await created(world, owner, { name });
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const response = await list(world, owner, `?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as TeamList;
        seen.push(...body.items.map((team) => team.name));
        cursor = body.nextCursor;
        if (cursor === null) {
          break;
        }
      }
      expect(seen).toEqual(["Alpha", "Bravo", "charlie", "delta", "echo"]);

      const first = (await (await list(world, owner, "?limit=1")).json()) as TeamList;
      const issued = first.nextCursor;
      expect(issued).not.toBeNull();
      expect((await list(world, stranger, `?cursor=${encodeURIComponent(issued ?? "")}`)).status).toBe(400);
      expect((await list(world, owner, `?cursor=${encodeURIComponent(`${issued ?? ""}x`)}`)).status).toBe(400);
      expect((await list(world, owner, "?cursor=forged")).status).toBe(400);
      expect((await list(world, owner, "?limit=0")).status).toBe(422);
      expect((await list(world, owner, "?limit=101")).status).toBe(422);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("getTeam", () => {
  it(
    "answers every member, a plain member included, the team with its members under their display names and addresses, and its ETag",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, member, other } = await setup(world);
      const team = await created(world, owner, { name: "Design" });
      await replace(world, owner, team.id, [other.account.id, member.account.id]);

      const response = await read(world, member, team.id);

      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe('"2"');
      const body = (await response.json()) as Team;
      expect(body).toMatchObject({ id: team.id, name: "Design", memberCount: 2, version: 2 });
      expect(sorted((body.members ?? []).map((entry) => entry.accountId))).toEqual(sorted([member.account.id, other.account.id]));
      for (const entry of body.members ?? []) {
        expect(Object.keys(entry).sort()).toEqual(["accountId", "displayName", "email"]);
      }
      expect((body.members ?? []).find((entry) => entry.accountId === member.account.id)?.email).toBe(member.account.email);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 for an identifier that is no UUID",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner } = await setup(world);
      expect((await read(world, owner, "not-a-uuid")).status).toBe(422);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("updateTeam", () => {
  it(
    "renames and describes the team, moves the version and the ETag, and records team.updated with the old and the new name",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { admin, a } = await setup(world);
      const team = await created(world, admin, { name: "Design", description: "Old" });

      const response = await patch(world, admin, team.id, { name: " Studio ", description: "New" });

      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe('"2"');
      expect(await response.json()).toMatchObject({ id: team.id, name: "Studio", description: "New", version: 2 });
      expect(await auditOf(a.workspaceId)).toMatchObject([{ action: "team.created" }, { action: "team.updated", entity_id: team.id, metadata: { from: "Design", to: "Studio" } }]);

      const described = await patch(world, admin, team.id, { description: "" });
      expect(await described.json()).toMatchObject({ name: "Studio", description: "", version: 3 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 200 with the unchanged version and records nothing for a patch that names the values the team has, and for an empty one",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { admin, a } = await setup(world);
      const team = await created(world, admin, { name: "Design", description: "About" });

      for (const body of [{}, { name: "Design" }, { name: "Design", description: "About" }]) {
        const response = await patch(world, admin, team.id, body);
        expect(response.status).toBe(200);
        expect(response.headers.get("etag")).toBe('"1"');
        expect(await response.json()).toMatchObject({ version: 1, updatedAt: team.updatedAt });
      }
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["team.created"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "compares If-Match with the version under the team's lock: a mismatch is 412 with nothing written, a match and * apply",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { admin, a } = await setup(world);
      const team = await created(world, admin, { name: "Design" });
      await patch(world, admin, team.id, { description: "v2" });

      for (const header of ['"1"', 'W/"2"', "2", '""', '"x"']) {
        const stale = await patch(world, admin, team.id, { name: "Stale" }, { "if-match": header });
        expect(stale.status).toBe(412);
        expect((await problemOf(stale)).code).toBe("precondition_failed");
      }
      expect((await storedTeams()).find((stored) => stored.id === team.id)).toMatchObject({ name: "Design", version: 2 });

      expect((await patch(world, admin, team.id, { name: "Matched" }, { "if-match": '"1", "2"' })).status).toBe(200);
      expect((await patch(world, admin, team.id, { name: "Any" }, { "if-match": "*" })).status).toBe(200);
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["team.created", "team.updated", "team.updated", "team.updated"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 409 name_taken for the name of another team in any case, and lets a team change the case of its own name",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { admin } = await setup(world);
      const design = await created(world, admin, { name: "Design" });
      const ops = await created(world, admin, { name: "Ops" });

      const refused = await patch(world, admin, ops.id, { name: "DESIGN", description: "changed" });
      expect(refused.status).toBe(409);
      expect((await problemOf(refused)).errors).toEqual([{ path: "name", code: "name_taken" }]);
      expect((await storedTeams()).find((stored) => stored.id === ops.id)).toMatchObject({ name: "Ops", description: "", version: 1 });

      const recased = await patch(world, admin, design.id, { name: "design" });
      expect(recased.status).toBe(200);
      expect(await recased.json()).toMatchObject({ name: "design", version: 2 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 for a name that is blank or longer than 64 characters, a description longer than 280 and a field it does not declare, writing nothing",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { admin } = await setup(world);
      const team = await created(world, admin, { name: "Design" });
      for (const body of [{ name: "" }, { name: "n".repeat(65) }, { description: "d".repeat(281) }, { owner: "me" }, { name: null }, { name: "nul\u0000name" }, { description: "nul\u0000description" }]) {
        expect((await patch(world, admin, team.id, body)).status).toBe(422);
      }
      expect((await storedTeams()).find((stored) => stored.id === team.id)).toMatchObject({ name: "Design", version: 1 });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("deleteTeam", () => {
  it(
    "answers 204, deletes the team with its memberships, leaves the members in the workspace, records team.deleted, and answers 404 to the repeat",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin, member, a } = await setup(world);
      const team = await created(world, owner, { name: "Doomed" });
      await replace(world, owner, team.id, [member.account.id, admin.account.id]);

      const response = await remove(world, admin, team.id);

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(await storedMemberships(team.id)).toEqual([]);
      expect((await storedTeams()).map((stored) => stored.name)).toEqual(["Team of B"]);
      const members = (await (await send(world, "GET", MEMBERS, { cookie: owner.cookie })).json()) as { items: { accountId: string }[] };
      expect(members.items.map((entry) => entry.accountId)).toContain(member.account.id);
      expect(await auditOf(a.workspaceId)).toMatchObject([
        { action: "team.created" },
        { action: "team.members_changed", metadata: { name: "Doomed" } },
        { action: "team.deleted", entity_id: team.id, metadata: { name: "Doomed" } },
      ]);

      expect((await remove(world, admin, team.id)).status).toBe(404);
      expect((await read(world, admin, team.id)).status).toBe(404);
      expect((await auditOf(a.workspaceId)).filter((event) => event.action === "team.deleted")).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("replaceTeamMembers", () => {
  it(
    "replaces the member set: accounts outside it leave the team, accounts in it join, one named twice counts once, and the version moves by one",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin, member, other, a } = await setup(world);
      const team = await created(world, admin, { name: "Design" });
      await replace(world, admin, team.id, [owner.account.id, member.account.id]);

      const response = await replace(world, admin, team.id, [member.account.id, other.account.id, other.account.id.toUpperCase()]);

      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe('"3"');
      const body = (await response.json()) as Team;
      expect(body).toMatchObject({ memberCount: 2, version: 3 });
      expect(sorted((body.members ?? []).map((entry) => entry.accountId))).toEqual(sorted([member.account.id, other.account.id]));
      expect(await storedMemberships(team.id)).toEqual(sorted([member.account.id, other.account.id]));
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["team.created", "team.members_changed", "team.members_changed"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "compares If-Match with the version under the team's lock: two replacements made against one version, the second is 412 with nothing written and the first's set stands",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin, member, other, a } = await setup(world);
      const team = await created(world, admin, { name: "Design" });
      const seeded = await replace(world, admin, team.id, [owner.account.id, member.account.id]);
      const readVersion = seeded.headers.get("etag") ?? "";
      expect(readVersion).toBe('"2"');

      const first = await replace(world, admin, team.id, [owner.account.id, member.account.id, other.account.id], { "if-match": readVersion });
      expect(first.status).toBe(200);
      expect(first.headers.get("etag")).toBe('"3"');
      const second = await replace(world, owner, team.id, [owner.account.id], { "if-match": readVersion });

      expect(second.status).toBe(412);
      expect((await problemOf(second)).code).toBe("precondition_failed");
      expect(await storedMemberships(team.id)).toEqual(sorted([owner.account.id, member.account.id, other.account.id]));
      expect((await storedTeams()).find((stored) => stored.id === team.id)).toMatchObject({ version: 3 });
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["team.created", "team.members_changed", "team.members_changed"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads If-Match like the PATCH does: a list of tags matches any of them, * and no header apply, an unreadable one is 412; the GET answers the version the PUT takes",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin, member } = await setup(world);
      const team = await created(world, admin, { name: "Design" });

      for (const header of ['"2"', 'W/"1"', "1", '""', '"x"']) {
        const stale = await replace(world, admin, team.id, [owner.account.id], { "if-match": header });
        expect(stale.status).toBe(412);
      }
      expect(await storedMemberships(team.id)).toEqual([]);

      const read1 = await read(world, admin, team.id);
      expect(read1.headers.get("etag")).toBe('"1"');
      expect((await replace(world, admin, team.id, [owner.account.id], { "if-match": read1.headers.get("etag") ?? "" })).status).toBe(200);
      expect((await replace(world, admin, team.id, [member.account.id], { "if-match": '"1", "2"' })).status).toBe(200);
      expect((await replace(world, admin, team.id, [owner.account.id], { "if-match": "*" })).status).toBe(200);
      expect((await replace(world, admin, team.id, [owner.account.id, member.account.id])).status).toBe(200);
      expect((await read(world, admin, team.id)).headers.get("etag")).toBe('"5"');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves the version where it is for a set the team has already, as a patch that changes nothing does, and a patch made against the version a replacement moved is 412",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin } = await setup(world);
      const team = await created(world, admin, { name: "Design" });
      await replace(world, admin, team.id, [owner.account.id]);

      const repeated = await replace(world, admin, team.id, [owner.account.id], { "if-match": '"2"' });
      expect(repeated.status).toBe(200);
      expect(repeated.headers.get("etag")).toBe('"2"');
      expect((await patch(world, admin, team.id, { name: "Stale" }, { "if-match": '"1"' })).status).toBe(412);
      const renamed = await patch(world, admin, team.id, { name: "Studio" }, { "if-match": '"2"' });
      expect(renamed.status).toBe(200);
      expect(renamed.headers.get("etag")).toBe('"3"');
      expect((await replace(world, admin, team.id, [], { "if-match": '"2"' })).status).toBe(412);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "records team.members_changed with the team's name and no member, and records nothing for the set the team has",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, admin, a } = await setup(world);
      const team = await created(world, admin, { name: "Design" });

      expect((await replace(world, admin, team.id, [owner.account.id])).status).toBe(200);
      expect((await replace(world, admin, team.id, [owner.account.id])).status).toBe(200);
      expect((await replace(world, admin, team.id, [])).status).toBe(200);
      expect((await replace(world, admin, team.id, [])).status).toBe(200);

      const events = await auditOf(a.workspaceId);
      expect(events.map((event) => event.action)).toEqual(["team.created", "team.members_changed", "team.members_changed"]);
      for (const event of events.slice(1)) {
        expect(event.metadata).toEqual({ name: "Design" });
        expect(event.entity_id).toBe(team.id);
        expect(JSON.stringify(event.metadata)).not.toContain(owner.account.id);
      }
      expect(await storedMemberships(team.id)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 validation_failed for an account that is no member of the workspace, one of another workspace included, and writes nothing",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, member, stranger, a } = await setup(world);
      const team = await created(world, owner, { name: "Design" });
      await replace(world, owner, team.id, [owner.account.id]);
      const outsider = await harness.person(world);

      for (const accountId of [stranger.account.id, outsider.account.id, crypto.randomUUID()]) {
        const response = await replace(world, owner, team.id, [member.account.id, accountId]);
        expect(response.status).toBe(422);
        const problem = await problemOf(response);
        expect(problem.code).toBe("validation_failed");
        expect(problem.errors).toEqual([{ path: "accountIds", code: "unknown_member" }]);
      }
      expect(await storedMemberships(team.id)).toEqual([owner.account.id]);
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["team.created", "team.members_changed"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 for a body that is not a closed list of at most 1 000 identifiers",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner } = await setup(world);
      const team = await created(world, owner, { name: "Design" });
      const put = (body: unknown) => send(world, "PUT", `${TEAMS}/${team.id}/members`, { cookie: owner.cookie }, body);
      expect((await put({})).status).toBe(422);
      expect((await put({ accountIds: "x" })).status).toBe(422);
      expect((await put({ accountIds: ["not-a-uuid"] })).status).toBe(422);
      expect((await put({ accountIds: [], extra: 1 })).status).toBe(422);
      expect((await put({ accountIds: Array.from({ length: 1001 }, () => crypto.randomUUID()) })).status).toBe(422);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a member who leaves", () => {
  it(
    "takes the membership of every team with them when removed from the workspace, and the teams and their other members stay",
    async () => {
      const world = harness.serve({ entitlements: GRANTED });
      const { owner, member, other } = await setup(world);
      const design = await created(world, owner, { name: "Design" });
      const ops = await created(world, owner, { name: "Ops" });
      await replace(world, owner, design.id, [member.account.id, other.account.id]);
      await replace(world, owner, ops.id, [member.account.id]);

      const removed = await send(world, "DELETE", `${MEMBERS}/${member.account.id}`, { cookie: owner.cookie }, { content: "delete" });
      expect(removed.status).toBe(200);

      expect(await storedMemberships(design.id)).toEqual([other.account.id]);
      expect(await storedMemberships(ops.id)).toEqual([]);
      const readBack = (await (await read(world, owner, design.id)).json()) as Team;
      expect(readBack).toMatchObject({ memberCount: 1 });
      expect((await storedTeams()).map((stored) => stored.name)).toEqual(["Design", "Ops", "Team of B"]);
    },
    TEST_TIMEOUT_MS,
  );
});
