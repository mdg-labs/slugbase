import type { EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET /api/v1/share-targets and GET, POST /api/v1/bookmarks/{id}/shares and DELETE /api/v1/bookmarks/{id}/shares/{shareId} (doc 04 section 10.7, doc 02
// section 8, doc 05 section 2.5, doc 10 T1, T2 and T11), through the whole chain over the migrated database. The failure scenario: a member of the workspace
// grants a share on another member's bookmark by its identifier (and so does an admin, who has no implicit access), and the owner shares with an account
// that is no member of the workspace or with the team of another workspace; every one fails and writes no row (T2, T1). Besides that: a grant answers 201 and
// a repeat 200 with the same share; the list shows the shares and the audience; a revocation ends a share; a token may grant and revoke with the write scope
// and read nothing; the audit log names the target and nothing of the bookmark; the search offers the members other than the caller and the teams.
// The entitlements are held by the check these tests pass; their refusal is held in `entitlements/sharing-enforcement.integration.test.ts`.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const TEAMS = "/api/v1/teams";
const TARGETS = "/api/v1/share-targets";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "sharing.members" || entitlement === "sharing.teams" || entitlement === "teams.manage";
const TITLE = "A private bookmark title";
const URL_OF_BOOKMARK = "https://example.com/private-address";

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

interface Share {
  readonly id: string;
  readonly kind: "member" | "team";
  readonly accountId: string | null;
  readonly teamId: string | null;
  readonly name: string;
  readonly email: string | null;
  readonly createdAt: string;
}

interface ShareList {
  readonly items: readonly Share[];
  readonly audienceSize: number;
}

interface Target {
  readonly kind: "member" | "team";
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const sharesPath = (bookmarkId: string) => `${BOOKMARKS}/${bookmarkId}/shares`;
const list = (world: World, as: Person, bookmarkId: string) => send(world, "GET", sharesPath(bookmarkId), { cookie: as.cookie });
const grant = (world: World, as: Person, bookmarkId: string, body: unknown) => send(world, "POST", sharesPath(bookmarkId), { cookie: as.cookie }, body);
const revoke = (world: World, as: Person, bookmarkId: string, shareId: string) => send(world, "DELETE", `${sharesPath(bookmarkId)}/${shareId}`, { cookie: as.cookie });
const targets = (world: World, as: Person, query = "") => send(world, "GET", `${TARGETS}${query}`, { cookie: as.cookie });

async function bookmarkOf(world: World, as: Person, title = TITLE, url = URL_OF_BOOKMARK): Promise<string> {
  const response = await send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url, title });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function teamOf(world: World, as: Person, name: string, members: readonly Person[]): Promise<string> {
  const created = await send(world, "POST", TEAMS, { cookie: as.cookie }, { name });
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  expect((await send(world, "PUT", `${TEAMS}/${id}/members`, { cookie: as.cookie }, { accountIds: members.map((person) => person.account.id) })).status).toBe(200);
  return id;
}

interface StoredShare {
  id: string;
  workspace_id: string;
  bookmark_id: string;
  target_account_id: string | null;
  target_team_id: string | null;
  granted_by: string | null;
}

async function storedShares(): Promise<StoredShare[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<StoredShare[]>`SELECT id, workspace_id, bookmark_id, target_account_id, target_team_id, granted_by FROM bookmark_shares ORDER BY id`;
  });
}

interface AuditRow {
  action: string;
  actor_type: string;
  actor_account_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, string>;
}

async function auditOf(workspaceId: string): Promise<AuditRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<AuditRow[]>`
      SELECT action, actor_type, actor_account_id, entity_type, entity_id, metadata
      FROM audit_events WHERE workspace_id = ${workspaceId} AND action LIKE 'share.%' ORDER BY created_at, id`;
  });
  return [...rows];
}

/** Workspace A with an owner, an admin and three plain members, and workspace B of a stranger who owns a bookmark and a team there. */
async function setup(world: World) {
  const owner = await harness.person(world);
  const admin = await harness.person(world);
  const max = await harness.person(world);
  const mia = await harness.person(world);
  const cy = await harness.person(world);
  const stranger = await harness.person(world);
  const a = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: admin, role: "admin" },
    { person: max, role: "member" },
    { person: mia, role: "member" },
    { person: cy, role: "member" },
  ]);
  const b = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  const bookmark = await bookmarkOf(world, owner);
  const bookmarkOfB = await bookmarkOf(world, stranger, "B only", "https://example.com/b-only");
  const teamOfB = await teamOf(world, stranger, "Team of B", [stranger]);
  return { owner, admin, max, mia, cy, stranger, a, b, bookmark, bookmarkOfB, teamOfB };
}

const SELF_ENTITLED = { entitlements: GRANTED } as const;

describe("the failure scenario", () => {
  it(
    "answers 404 to a member and to an admin of the workspace who grant, list or revoke on another member's bookmark by its identifier, and writes no row",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, admin, max, mia, a, bookmark } = await setup(world);
      const team = await teamOf(world, owner, "Design", [mia]);
      const owned = await grant(world, owner, bookmark, { accountId: mia.account.id });
      const kept = ((await owned.json()) as Share).id;
      const before = await storedShares();
      expect(before).toHaveLength(1);

      for (const as of [max, admin]) {
        const responses = [
          await grant(world, as, bookmark, { accountId: as.account.id }),
          await grant(world, as, bookmark, { accountId: mia.account.id }),
          await grant(world, as, bookmark, { teamId: team }),
          await list(world, as, bookmark),
          await revoke(world, as, bookmark, kept),
        ];
        expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
        for (const response of responses) {
          expect((await problemOf(response)).code).toBe("not_found");
        }
      }

      expect(await storedShares()).toEqual(before);
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["share.granted"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 for a bookmark of workspace B, and for one that does not exist, as it does for another member's, and 404 for a share of another bookmark",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, bookmark, bookmarkOfB, b } = await setup(world);
      const other = await bookmarkOf(world, owner, "Another bookmark", "https://example.com/another");
      const share = ((await (await grant(world, owner, bookmark, { accountId: max.account.id })).json()) as Share).id;
      const before = await storedShares();

      const responses = [
        await list(world, owner, bookmarkOfB),
        await grant(world, owner, bookmarkOfB, { accountId: max.account.id }),
        await revoke(world, owner, bookmarkOfB, share),
        await list(world, owner, "0192f3a0-cccc-7000-8000-0000000000aa"),
        await grant(world, owner, "0192f3a0-cccc-7000-8000-0000000000aa", { accountId: max.account.id }),
        await revoke(world, owner, other, share),
        await revoke(world, owner, bookmark, "0192f3a0-cccc-7000-8000-0000000000ab"),
      ];

      expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
      expect(await storedShares()).toEqual(before);
      expect(await auditOf(b.workspaceId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 to the owner who shares with an account that is no member of the workspace, with an account that does not exist, with a team of another workspace and with themselves, and writes no row",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, stranger, a, bookmark, teamOfB } = await setup(world);

      const outsider = await grant(world, owner, bookmark, { accountId: stranger.account.id });
      const unknown = await grant(world, owner, bookmark, { accountId: "0192f3a0-cccc-7000-8000-0000000000ac" });
      const foreignTeam = await grant(world, owner, bookmark, { teamId: teamOfB });
      const unknownTeam = await grant(world, owner, bookmark, { teamId: "0192f3a0-cccc-7000-8000-0000000000ad" });
      const self = await grant(world, owner, bookmark, { accountId: owner.account.id });

      expect([outsider, unknown, foreignTeam, unknownTeam, self].map((response) => response.status)).toEqual([422, 422, 422, 422, 422]);
      expect((await problemOf(outsider)).errors).toEqual([{ path: "accountId", code: "unknown_member" }]);
      expect((await problemOf(unknown)).errors).toEqual([{ path: "accountId", code: "unknown_member" }]);
      expect((await problemOf(foreignTeam)).errors).toEqual([{ path: "teamId", code: "unknown_team" }]);
      expect((await problemOf(unknownTeam)).errors).toEqual([{ path: "teamId", code: "unknown_team" }]);
      const refusedSelf = await problemOf(self);
      expect(refusedSelf.code).toBe("validation_failed");
      expect(refusedSelf.errors).toEqual([{ path: "accountId", code: "cannot_share_with_self" }]);
      expect(await storedShares()).toEqual([]);
      expect(await auditOf(a.workspaceId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 to a body with no target, two targets, a malformed identifier or a field the operation does not declare",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, bookmark } = await setup(world);
      const team = await teamOf(world, owner, "Design", [max]);
      const bodies = [{}, { accountId: max.account.id, teamId: team }, { accountId: "not-an-identifier" }, { teamId: 7 }, { accountId: max.account.id, role: "owner" }];
      const responses = await Promise.all(bodies.map((body) => grant(world, owner, bookmark, body)));
      expect(responses.map((response) => response.status)).toEqual([422, 422, 422, 422, 422]);
      expect(await storedShares()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("granting", () => {
  it(
    "shares a bookmark with a member and answers 201, and a repeated grant answers 200 with the same share and writes and records nothing more",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, a, bookmark } = await setup(world);

      const first = await grant(world, owner, bookmark, { accountId: max.account.id });
      const share = (await first.json()) as Share;
      const again = await grant(world, owner, bookmark, { accountId: max.account.id });

      expect(first.status).toBe(201);
      expect(share).toMatchObject({ kind: "member", accountId: max.account.id, teamId: null, email: max.account.email });
      expect(typeof share.name).toBe("string");
      expect(again.status).toBe(200);
      expect(((await again.json()) as Share).id).toBe(share.id);
      expect(await storedShares()).toEqual([{ id: share.id, workspace_id: a.workspaceId, bookmark_id: bookmark, target_account_id: max.account.id, target_team_id: null, granted_by: owner.account.id }]);
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["share.granted"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "shares a bookmark with a team and answers 201 with the team's name, and no email",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, mia, bookmark } = await setup(world);
      const team = await teamOf(world, owner, "Design", [max, mia]);

      const response = await grant(world, owner, bookmark, { teamId: team });

      expect(response.status).toBe(201);
      expect((await response.json()) as Share).toMatchObject({ kind: "team", accountId: null, teamId: team, name: "Design", email: null });
      expect((await storedShares()).map((share) => [share.target_account_id, share.target_team_id])).toEqual([[null, team]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "makes one share of two grants to one target that arrive at the same time",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, bookmark } = await setup(world);

      const responses = await Promise.all(Array.from({ length: 4 }, () => grant(world, owner, bookmark, { accountId: max.account.id })));

      expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 201]);
      const ids = await Promise.all(responses.map(async (response) => ((await response.json()) as Share).id));
      expect(new Set(ids).size).toBe(1);
      expect(await storedShares()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a bookmark the plan archived, whose existing share can still be listed and revoked",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, mia, bookmark } = await setup(world);
      const shared = (await (await grant(world, owner, bookmark, { accountId: max.account.id })).json()) as Share;
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${bookmark}`;
      });

      expect((await grant(world, owner, bookmark, { accountId: mia.account.id })).status).toBe(404);
      expect(((await (await list(world, owner, bookmark)).json()) as ShareList).items.map((share) => share.id)).toEqual([shared.id]);
      expect((await revoke(world, owner, bookmark, shared.id)).status).toBe(204);
      expect(await storedShares()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("listing and revoking", () => {
  it(
    "lists the shares oldest first with the size of the audience: the distinct members other than the owner, shared with directly or through a team",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, admin, max, mia, cy, bookmark } = await setup(world);
      const design = await teamOf(world, owner, "Design", [owner, admin, max]);
      const ops = await teamOf(world, owner, "Ops", [max, mia]);
      const empty = await teamOf(world, owner, "Empty", []);
      expect((await list(world, owner, bookmark)).status).toBe(200);
      expect((await (await list(world, owner, bookmark)).json()) as ShareList).toEqual({ items: [], audienceSize: 0 });

      for (const body of [{ teamId: design }, { teamId: ops }, { accountId: max.account.id }, { accountId: cy.account.id }, { teamId: empty }]) {
        expect((await grant(world, owner, bookmark, body)).status).toBe(201);
      }
      const listed = (await (await list(world, owner, bookmark)).json()) as ShareList;

      // the admin and Max through Design, Max and Mia through Ops, Max and Cy directly: four members, the owner (in Design) is not counted
      expect(listed.audienceSize).toBe(4);
      expect(listed.items.map((share) => [share.kind, share.name])).toEqual([["team", "Design"], ["team", "Ops"], ["member", expect.any(String)], ["member", expect.any(String)], ["team", "Empty"]]);
      expect(listed.items.map((share) => Date.parse(share.createdAt))).toEqual([...listed.items.map((share) => Date.parse(share.createdAt))].sort((left, right) => left - right));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "revokes a share with 204 and a repeat with 404, takes the member out of the audience, and records share.revoked",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, mia, a, bookmark } = await setup(world);
      const first = (await (await grant(world, owner, bookmark, { accountId: max.account.id })).json()) as Share;
      await grant(world, owner, bookmark, { accountId: mia.account.id });

      const revoked = await revoke(world, owner, bookmark, first.id);
      const again = await revoke(world, owner, bookmark, first.id);

      expect(revoked.status).toBe(204);
      expect(await revoked.text()).toBe("");
      expect(again.status).toBe(404);
      expect(((await (await list(world, owner, bookmark)).json()) as ShareList).audienceSize).toBe(1);
      expect((await storedShares()).map((share) => share.target_account_id)).toEqual([mia.account.id]);
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["share.granted", "share.granted", "share.revoked"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drops a member from the shares and the audience when they leave the workspace, and a team's shares when it is deleted",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, mia, a, bookmark } = await setup(world);
      const team = await teamOf(world, owner, "Design", [mia]);
      await grant(world, owner, bookmark, { accountId: max.account.id });
      await grant(world, owner, bookmark, { teamId: team });
      expect(((await (await list(world, owner, bookmark)).json()) as ShareList).audienceSize).toBe(2);

      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`DELETE FROM workspace_members WHERE workspace_id = ${a.workspaceId} AND account_id = ${max.account.id}`;
      });
      expect(await list(world, owner, bookmark).then((response) => response.json())).toMatchObject({ audienceSize: 1 });
      expect((await send(world, "DELETE", `${TEAMS}/${team}`, { cookie: owner.cookie })).status).toBe(204);
      expect(await list(world, owner, bookmark).then((response) => response.json())).toEqual({ items: [], audienceSize: 0 });
      expect(await storedShares()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the audit log", () => {
  it(
    "records the grant and the revocation with the kind, the identifier and the name of the target, and nothing of the bookmark",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, mia, a, bookmark } = await setup(world);
      const team = await teamOf(world, owner, "Design", [mia]);
      const memberShare = (await (await grant(world, owner, bookmark, { accountId: max.account.id })).json()) as Share;
      const teamShare = (await (await grant(world, owner, bookmark, { teamId: team })).json()) as Share;
      await revoke(world, owner, bookmark, memberShare.id);
      await revoke(world, owner, bookmark, teamShare.id);

      const events = await auditOf(a.workspaceId);

      expect(events.map((event) => [event.action, event.actor_type, event.actor_account_id, event.entity_type, event.entity_id, event.metadata])).toEqual([
        ["share.granted", "account", owner.account.id, "bookmark", bookmark, { targetKind: "member", targetId: max.account.id, targetName: memberShare.name }],
        ["share.granted", "account", owner.account.id, "bookmark", bookmark, { targetKind: "team", targetId: team, targetName: "Design" }],
        ["share.revoked", "account", owner.account.id, "bookmark", bookmark, { targetKind: "member", targetId: max.account.id, targetName: memberShare.name }],
        ["share.revoked", "account", owner.account.id, "bookmark", bookmark, { targetKind: "team", targetId: team, targetName: "Design" }],
      ]);
      const text = JSON.stringify(events);
      expect(text).not.toContain(TITLE);
      expect(text).not.toContain(URL_OF_BOOKMARK);
      expect(text).not.toContain(max.account.email);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("an API token", () => {
  it(
    "grants and revokes with the write scope and is named as the actor, and reads nothing: a read token and a read-write token are refused the two reads, a read token the two writes",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, a, bookmark } = await setup(world);
      const readOnly = await harness.token(a.workspaceId, owner, "read");
      const readWrite = await harness.token(a.workspaceId, owner, "read-write");

      const refusedWrite = await send(world, "POST", sharesPath(bookmark), bearer(readOnly), { accountId: max.account.id });
      expect(refusedWrite.status).toBe(403);
      expect((await problemOf(refusedWrite)).code).toBe("token_scope");
      for (const token of [readOnly, readWrite]) {
        expect((await send(world, "GET", sharesPath(bookmark), bearer(token))).status).toBe(403);
        expect((await send(world, "GET", TARGETS, bearer(token))).status).toBe(403);
      }
      expect(await storedShares()).toEqual([]);

      const granted = await send(world, "POST", sharesPath(bookmark), bearer(readWrite), { accountId: max.account.id });
      expect(granted.status).toBe(201);
      const share = (await granted.json()) as Share;
      expect((await send(world, "DELETE", `${sharesPath(bookmark)}/${share.id}`, bearer(readOnly))).status).toBe(403);
      expect((await send(world, "DELETE", `${sharesPath(bookmark)}/${share.id}`, bearer(readWrite))).status).toBe(204);
      expect((await auditOf(a.workspaceId)).map((event) => [event.action, event.actor_type, event.actor_account_id])).toEqual([
        ["share.granted", "api_token", owner.account.id],
        ["share.revoked", "api_token", owner.account.id],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "grants nothing on another member's bookmark either: the token acts as its account",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { max, mia, a, bookmark } = await setup(world);
      const token = await harness.token(a.workspaceId, max, "read-write");
      const response = await send(world, "POST", sharesPath(bookmark), bearer(token), { accountId: mia.account.id });
      expect(response.status).toBe(404);
      expect(await storedShares()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the share targets", () => {
  it(
    "lists the members other than the caller and the teams of the workspace, by name, and nothing of another workspace",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, a, teamOfB } = await setup(world);
      await teamOf(world, owner, "Design", [max]);
      await teamOf(world, owner, "Ops", []);

      const response = await targets(world, owner);
      const found = (await response.json()) as { items: Target[] };

      expect(response.status).toBe(200);
      const members = found.items.filter((target) => target.kind === "member");
      const roles = await harness.rolesOf(a.workspaceId);
      expect(members.map((target) => target.id).sort()).toEqual(Object.keys(roles).filter((id) => id !== owner.account.id).sort());
      expect(members.every((target) => typeof target.email === "string")).toBe(true);
      expect(found.items.filter((target) => target.kind === "team").map((target) => [target.name, target.email])).toEqual([["Design", null], ["Ops", null]]);
      expect(found.items.map((target) => target.id)).not.toContain(owner.account.id);
      expect(found.items.map((target) => target.id)).not.toContain(teamOfB);
      expect(JSON.stringify(found)).not.toContain("Team of B");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "filters by a part of a name or an address without regard to case, takes a limit, and reads the wildcards of LIKE as text",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max } = await setup(world);
      await teamOf(world, owner, "Design", [max]);
      await teamOf(world, owner, "Dev_ops", []);

      const names = async (query: string) => ((await (await targets(world, owner, query)).json()) as { items: Target[] }).items.map((target) => target.name);

      expect(await names("?q=DESI")).toEqual(["Design"]);
      expect(await names("?q=dev_")).toEqual(["Dev_ops"]);
      expect(await names("?q=%25")).toEqual([]);
      expect(await names(`?q=${encodeURIComponent(max.account.email.toUpperCase())}`)).toHaveLength(1);
      expect((await names("?limit=2")).length).toBe(2);
      expect(await names("?q=nobody-is-called-this")).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 422 to a blank text, a text with a NUL, one of 101 characters, a limit of 0 or 51, and a parameter it does not declare",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner } = await setup(world);
      for (const query of ["?q=", "?q=%20%20", "?q=a%00b", `?q=${"x".repeat(101)}`, "?limit=0", "?limit=51", "?other=1"]) {
        expect((await targets(world, owner, query)).status, query).toBe(422);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 401 without a session",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      await setup(world);
      expect((await send(world, "GET", TARGETS, {})).status).toBe(401);
      expect((await send(world, "POST", sharesPath("0192f3a0-cccc-7000-8000-0000000000aa"), {}, { accountId: "0192f3a0-cccc-7000-8000-0000000000ac" })).status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );
});
