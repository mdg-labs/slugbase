import type { EntitlementCheck } from "@slugbase/core";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// GET, POST /api/v1/folders/{id}/shares and DELETE /api/v1/folders/{id}/shares/{shareId} (doc 04 section 10.7, doc 02 section 8, doc 05 section 2.5, doc 10 T1,
// T2 and T11), through the whole chain over the migrated database. The failure scenario: a member of the workspace grants a share on another member's folder by
// its identifier (and so does an admin, who has no implicit access), and the owner shares with an account that is no member of the workspace or with the team of
// another workspace; every one fails and writes no row (T2, T1). Besides that: a grant answers 201 and a repeat 200 with the same share; the list shows the shares
// and the audience; a revocation ends a share; the deletion of a folder and of a team take their shares with them; a token may grant and revoke with the write scope
// and read nothing; the audit log is about the folder, names the target and nothing of the folder. The entitlements are held by the check these tests pass; their
// refusal is held in `entitlements/sharing-enforcement.integration.test.ts`.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const FOLDERS = "/api/v1/folders";
const TEAMS = "/api/v1/teams";
const GRANTED: EntitlementCheck = (entitlement) => entitlement === "sharing.members" || entitlement === "sharing.teams" || entitlement === "teams.manage";
const FOLDER_NAME = "A private folder name";

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

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const sharesPath = (folderId: string) => `${FOLDERS}/${folderId}/shares`;
const list = (world: World, as: Person, folderId: string) => send(world, "GET", sharesPath(folderId), { cookie: as.cookie });
const grant = (world: World, as: Person, folderId: string, body: unknown) => send(world, "POST", sharesPath(folderId), { cookie: as.cookie }, body);
const revoke = (world: World, as: Person, folderId: string, shareId: string) => send(world, "DELETE", `${sharesPath(folderId)}/${shareId}`, { cookie: as.cookie });

async function folderOf(world: World, as: Person, name = FOLDER_NAME): Promise<string> {
  const response = await send(world, "POST", FOLDERS, { cookie: as.cookie }, { name });
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
  folder_id: string;
  target_account_id: string | null;
  target_team_id: string | null;
  granted_by: string | null;
}

async function storedShares(): Promise<StoredShare[]> {
  return database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<StoredShare[]>`SELECT id, workspace_id, folder_id, target_account_id, target_team_id, granted_by FROM folder_shares ORDER BY id`;
  });
}

async function bookmarkShareCount(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmark_shares`;
  });
  return rows[0]?.n ?? -1;
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

/** Workspace A with an owner, an admin and three plain members, and workspace B of a stranger who owns a folder and a team there. */
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
  const folder = await folderOf(world, owner);
  const folderOfB = await folderOf(world, stranger, "B only");
  const teamOfB = await teamOf(world, stranger, "Team of B", [stranger]);
  return { owner, admin, max, mia, cy, stranger, a, b, folder, folderOfB, teamOfB };
}

const SELF_ENTITLED = { entitlements: GRANTED } as const;

describe("the failure scenario", () => {
  it(
    "answers 404 to a member and to an admin of the workspace who grant, list or revoke on another member's folder by its identifier, and writes no row",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, admin, max, mia, a, folder } = await setup(world);
      const team = await teamOf(world, owner, "Design", [mia]);
      const owned = await grant(world, owner, folder, { accountId: mia.account.id });
      const kept = ((await owned.json()) as Share).id;
      const before = await storedShares();
      expect(before).toHaveLength(1);

      for (const as of [max, admin]) {
        const responses = [
          await grant(world, as, folder, { accountId: as.account.id }),
          await grant(world, as, folder, { accountId: mia.account.id }),
          await grant(world, as, folder, { teamId: team }),
          await list(world, as, folder),
          await revoke(world, as, folder, kept),
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
    "answers 403 to a member who reads the folder through a team or a direct share and 404 to one who cannot, writes no row and records nothing",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, mia, cy, a, folder } = await setup(world);
      const team = await teamOf(world, owner, "Design", [mia]);
      expect((await grant(world, owner, folder, { teamId: team })).status).toBe(201);
      const direct = ((await (await grant(world, owner, folder, { accountId: max.account.id })).json()) as Share).id;
      const before = await storedShares();
      const audited = await auditOf(a.workspaceId);

      for (const reader of [mia, max]) {
        expect((await send(world, "GET", `${FOLDERS}/${folder}`, { cookie: reader.cookie })).status).toBe(200);
        const responses = [
          await list(world, reader, folder),
          await grant(world, reader, folder, { accountId: cy.account.id }),
          await grant(world, reader, folder, { teamId: team }),
          await revoke(world, reader, folder, direct),
          await revoke(world, reader, folder, "0192f3a0-cccc-7000-8000-0000000000ab"),
        ];
        expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
        for (const response of responses) {
          expect((await problemOf(response)).code).toBe("forbidden");
        }
      }

      expect((await send(world, "GET", `${FOLDERS}/${folder}`, { cookie: cy.cookie })).status).toBe(404);
      const strangerAnswers = [await list(world, cy, folder), await grant(world, cy, folder, { accountId: cy.account.id }), await revoke(world, cy, folder, direct)];
      expect(strangerAnswers.map((response) => response.status)).toEqual([404, 404, 404]);
      expect(await storedShares()).toEqual(before);
      expect(await auditOf(a.workspaceId)).toEqual(audited);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 for a folder of workspace B, and for one that does not exist, as it does for another member's, and 404 for a share of another folder",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, folder, folderOfB, b } = await setup(world);
      const other = await folderOf(world, owner, "Another folder");
      const share = ((await (await grant(world, owner, folder, { accountId: max.account.id })).json()) as Share).id;
      const before = await storedShares();

      const responses = [
        await list(world, owner, folderOfB),
        await grant(world, owner, folderOfB, { accountId: max.account.id }),
        await revoke(world, owner, folderOfB, share),
        await list(world, owner, "0192f3a0-cccc-7000-8000-0000000000aa"),
        await grant(world, owner, "0192f3a0-cccc-7000-8000-0000000000aa", { accountId: max.account.id }),
        await revoke(world, owner, other, share),
        await revoke(world, owner, folder, "0192f3a0-cccc-7000-8000-0000000000ab"),
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
      const { owner, stranger, a, folder, teamOfB } = await setup(world);

      const outsider = await grant(world, owner, folder, { accountId: stranger.account.id });
      const unknown = await grant(world, owner, folder, { accountId: "0192f3a0-cccc-7000-8000-0000000000ac" });
      const foreignTeam = await grant(world, owner, folder, { teamId: teamOfB });
      const unknownTeam = await grant(world, owner, folder, { teamId: "0192f3a0-cccc-7000-8000-0000000000ad" });
      const self = await grant(world, owner, folder, { accountId: owner.account.id });

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
      const { owner, max, folder } = await setup(world);
      const team = await teamOf(world, owner, "Design", [max]);
      const bodies = [{}, { accountId: max.account.id, teamId: team }, { accountId: "not-an-identifier" }, { teamId: 7 }, { accountId: max.account.id, role: "owner" }];
      const responses = await Promise.all(bodies.map((body) => grant(world, owner, folder, body)));
      expect(responses.map((response) => response.status)).toEqual([422, 422, 422, 422, 422]);
      expect(await storedShares()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 for a folder whose owner has left the workspace: nobody owns it, so nobody lists, grants or revokes on it",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, a, folder } = await setup(world);
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE folders SET owner_id = NULL WHERE id = ${folder}`;
      });

      const responses = [await list(world, owner, folder), await grant(world, owner, folder, { accountId: max.account.id }), await revoke(world, owner, folder, "0192f3a0-cccc-7000-8000-0000000000ab")];

      expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
      expect(await storedShares()).toEqual([]);
      expect(await auditOf(a.workspaceId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("granting", () => {
  it(
    "shares a folder with a member and answers 201, and a repeated grant answers 200 with the same share and writes and records nothing more",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, a, folder } = await setup(world);

      const first = await grant(world, owner, folder, { accountId: max.account.id });
      const share = (await first.json()) as Share;
      const again = await grant(world, owner, folder, { accountId: max.account.id });

      expect(first.status).toBe(201);
      expect(share).toMatchObject({ kind: "member", accountId: max.account.id, teamId: null, email: max.account.email });
      expect(typeof share.name).toBe("string");
      expect(again.status).toBe(200);
      expect(((await again.json()) as Share).id).toBe(share.id);
      expect(await storedShares()).toEqual([{ id: share.id, workspace_id: a.workspaceId, folder_id: folder, target_account_id: max.account.id, target_team_id: null, granted_by: owner.account.id }]);
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["share.granted"]);
      expect(await bookmarkShareCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "shares a folder with a team and answers 201 with the team's name, and no email",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, mia, folder } = await setup(world);
      const team = await teamOf(world, owner, "Design", [max, mia]);

      const response = await grant(world, owner, folder, { teamId: team });

      expect(response.status).toBe(201);
      expect((await response.json()) as Share).toMatchObject({ kind: "team", accountId: null, teamId: team, name: "Design", email: null });
      expect((await storedShares()).map((share) => [share.target_account_id, share.target_team_id])).toEqual([[null, team]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "makes one share of grants to one target that arrive at the same time",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, folder } = await setup(world);

      const responses = await Promise.all(Array.from({ length: 4 }, () => grant(world, owner, folder, { accountId: max.account.id })));

      expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 201]);
      const ids = await Promise.all(responses.map(async (response) => ((await response.json()) as Share).id));
      expect(new Set(ids).size).toBe(1);
      expect(await storedShares()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("listing and revoking", () => {
  it(
    "lists the shares oldest first with the size of the audience: the distinct members other than the owner, shared with directly or through a team",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, admin, max, mia, cy, folder } = await setup(world);
      const design = await teamOf(world, owner, "Design", [owner, admin, max]);
      const ops = await teamOf(world, owner, "Ops", [max, mia]);
      const empty = await teamOf(world, owner, "Empty", []);
      expect((await (await list(world, owner, folder)).json()) as ShareList).toEqual({ items: [], audienceSize: 0 });

      for (const body of [{ teamId: design }, { teamId: ops }, { accountId: max.account.id }, { accountId: cy.account.id }, { teamId: empty }]) {
        expect((await grant(world, owner, folder, body)).status).toBe(201);
      }
      const listed = (await (await list(world, owner, folder)).json()) as ShareList;

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
      const { owner, max, mia, a, folder } = await setup(world);
      const first = (await (await grant(world, owner, folder, { accountId: max.account.id })).json()) as Share;
      await grant(world, owner, folder, { accountId: mia.account.id });

      const revoked = await revoke(world, owner, folder, first.id);
      const again = await revoke(world, owner, folder, first.id);

      expect(revoked.status).toBe(204);
      expect(await revoked.text()).toBe("");
      expect(again.status).toBe(404);
      expect(((await (await list(world, owner, folder)).json()) as ShareList).audienceSize).toBe(1);
      expect((await storedShares()).map((share) => share.target_account_id)).toEqual([mia.account.id]);
      expect((await auditOf(a.workspaceId)).map((event) => event.action)).toEqual(["share.granted", "share.granted", "share.revoked"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drops a member from the shares when they leave the workspace, a team's shares when it is deleted, and a folder's shares when it is deleted",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, mia, a, folder } = await setup(world);
      const team = await teamOf(world, owner, "Design", [mia]);
      const second = await folderOf(world, owner, "Second");
      await grant(world, owner, folder, { accountId: max.account.id });
      await grant(world, owner, folder, { teamId: team });
      await grant(world, owner, second, { teamId: team });
      expect(((await (await list(world, owner, folder)).json()) as ShareList).audienceSize).toBe(2);

      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`DELETE FROM workspace_members WHERE workspace_id = ${a.workspaceId} AND account_id = ${max.account.id}`;
      });
      expect(await list(world, owner, folder).then((response) => response.json())).toMatchObject({ audienceSize: 1 });
      expect((await send(world, "DELETE", `${FOLDERS}/${second}`, { cookie: owner.cookie })).status).toBe(204);
      expect((await storedShares()).map((share) => share.folder_id)).toEqual([folder]);
      expect((await send(world, "DELETE", `${TEAMS}/${team}`, { cookie: owner.cookie })).status).toBe(204);
      expect(await list(world, owner, folder).then((response) => response.json())).toEqual({ items: [], audienceSize: 0 });
      expect(await storedShares()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the audit log", () => {
  it(
    "records the grant and the revocation about the folder with the kind, the identifier and the name of the target, and nothing of the folder",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, mia, a, folder } = await setup(world);
      const team = await teamOf(world, owner, "Design", [mia]);
      const memberShare = (await (await grant(world, owner, folder, { accountId: max.account.id })).json()) as Share;
      const teamShare = (await (await grant(world, owner, folder, { teamId: team })).json()) as Share;
      await revoke(world, owner, folder, memberShare.id);
      await revoke(world, owner, folder, teamShare.id);

      const events = await auditOf(a.workspaceId);

      expect(events.map((event) => [event.action, event.actor_type, event.actor_account_id, event.entity_type, event.entity_id, event.metadata])).toEqual([
        ["share.granted", "account", owner.account.id, "folder", folder, { targetKind: "member", targetId: max.account.id, targetName: memberShare.name }],
        ["share.granted", "account", owner.account.id, "folder", folder, { targetKind: "team", targetId: team, targetName: "Design" }],
        ["share.revoked", "account", owner.account.id, "folder", folder, { targetKind: "member", targetId: max.account.id, targetName: memberShare.name }],
        ["share.revoked", "account", owner.account.id, "folder", folder, { targetKind: "team", targetId: team, targetName: "Design" }],
      ]);
      const text = JSON.stringify(events);
      expect(text).not.toContain(FOLDER_NAME);
      expect(text).not.toContain(max.account.email);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("an API token", () => {
  it(
    "grants and revokes with the write scope and is named as the actor, and reads nothing: a read token and a read-write token are refused the list, a read token the two writes",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, max, a, folder } = await setup(world);
      const readOnly = await harness.token(a.workspaceId, owner, "read");
      const readWrite = await harness.token(a.workspaceId, owner, "read-write");

      const refusedWrite = await send(world, "POST", sharesPath(folder), bearer(readOnly), { accountId: max.account.id });
      expect(refusedWrite.status).toBe(403);
      expect((await problemOf(refusedWrite)).code).toBe("token_scope");
      for (const token of [readOnly, readWrite]) {
        expect((await send(world, "GET", sharesPath(folder), bearer(token))).status).toBe(403);
      }
      expect(await storedShares()).toEqual([]);

      const granted = await send(world, "POST", sharesPath(folder), bearer(readWrite), { accountId: max.account.id });
      expect(granted.status).toBe(201);
      const share = (await granted.json()) as Share;
      expect((await send(world, "DELETE", `${sharesPath(folder)}/${share.id}`, bearer(readOnly))).status).toBe(403);
      expect((await send(world, "DELETE", `${sharesPath(folder)}/${share.id}`, bearer(readWrite))).status).toBe(204);
      expect((await auditOf(a.workspaceId)).map((event) => [event.action, event.actor_type, event.actor_account_id])).toEqual([
        ["share.granted", "api_token", owner.account.id],
        ["share.revoked", "api_token", owner.account.id],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "grants nothing on another member's folder either: the token acts as its account",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { max, mia, a, folder } = await setup(world);
      const token = await harness.token(a.workspaceId, max, "read-write");
      const response = await send(world, "POST", sharesPath(folder), bearer(token), { accountId: mia.account.id });
      expect(response.status).toBe(404);
      expect(await storedShares()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a shared folder and its bookmarks", () => {
  it(
    "keeps the shares of a folder when bookmarks are filed in it and taken out, and makes no share of a bookmark",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      const { owner, mia, folder } = await setup(world);
      const team = await teamOf(world, owner, "Design", [mia]);
      expect((await grant(world, owner, folder, { teamId: team })).status).toBe(201);
      const created = await send(world, "POST", BOOKMARKS, { cookie: owner.cookie }, { url: "https://example.com/later", title: "Later" });
      const bookmark = ((await created.json()) as { id: string }).id;

      expect((await send(world, "POST", `${FOLDERS}/${folder}/bookmarks`, { cookie: owner.cookie }, { bookmarkIds: [bookmark] })).status).toBe(200);
      expect((await send(world, "DELETE", `${FOLDERS}/${folder}/bookmarks`, { cookie: owner.cookie }, { bookmarkIds: [bookmark] })).status).toBe(200);

      expect((await storedShares()).map((share) => share.target_team_id)).toEqual([team]);
      expect(await bookmarkShareCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a request without a session", () => {
  it(
    "is answered 401",
    async () => {
      const world = harness.serve(SELF_ENTITLED);
      await setup(world);
      const folder = "0192f3a0-cccc-7000-8000-0000000000aa";
      expect((await send(world, "GET", sharesPath(folder), {})).status).toBe(401);
      expect((await send(world, "POST", sharesPath(folder), {}, { accountId: "0192f3a0-cccc-7000-8000-0000000000ac" })).status).toBe(401);
      expect((await send(world, "DELETE", `${sharesPath(folder)}/0192f3a0-cccc-7000-8000-0000000000ab`, {})).status).toBe(401);
    },
    TEST_TIMEOUT_MS,
  );
});
