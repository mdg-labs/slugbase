import { PortUnavailable, type AccountEntitlementValues, type EntitlementSource } from "@slugbase/core";
import { LimitedEntitlementSource } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// T11 at the sharing operations (doc 01 section 7.5, doc 02 section 8.1, doc 04 sections 3.2 and 10.7, doc 10 T11), through the whole chain over the
// migrated database: a grant needs `sharing.members` for a member and `sharing.teams` for a team, the search offers the kinds the workspace holds, and the
// list and the revocation need either; a workspace that holds neither is refused every one of the four with `403 entitlement_required`, which carries the
// entitlement and whether the plan has a better one to offer, and nothing is written. The handler decides these entitlements, not stage 9, because the kind
// of target is in the request: listShareTargets, listBookmarkShares, createBookmarkShare and deleteBookmarkShare are the operations tested here, and listFolderShares, createFolderShare and deleteFolderShare, which follow the same rules for a folder.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const TEAMS = "/api/v1/teams";
const FOLDERS = "/api/v1/folders";
const TARGETS = "/api/v1/share-targets";

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
  readonly upgradeAvailable?: unknown;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

const sharesPath = (bookmarkId: string) => `${BOOKMARKS}/${bookmarkId}/shares`;
const folderSharesPath = (folderId: string) => `${FOLDERS}/${folderId}/shares`;

interface Setup {
  readonly owner: Person;
  readonly member: Person;
  readonly bookmark: string;
  readonly folder: string;
  readonly team: string;
  readonly workspaceId: string;
}

/** A workspace with an owner and a member, a bookmark of the owner's and a team, made while the workspace holds every entitlement. */
async function setup(world: World): Promise<Setup> {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const workspace = await harness.workspaceOf([{ person: owner, role: "owner" }, { person: member, role: "member" }]);
  const created = await send(world, "POST", BOOKMARKS, { cookie: owner.cookie }, { url: "https://example.com/entitlement", title: "Entitlement" });
  expect(created.status).toBe(201);
  const team = await send(world, "POST", TEAMS, { cookie: owner.cookie }, { name: "Design" });
  expect(team.status).toBe(201);
  const folder = await send(world, "POST", FOLDERS, { cookie: owner.cookie }, { name: "Entitlement folder" });
  expect(folder.status).toBe(201);
  return { owner, member, bookmark: ((await created.json()) as { id: string }).id, folder: ((await folder.json()) as { id: string }).id, team: ((await team.json()) as { id: string }).id, workspaceId: workspace.workspaceId };
}

async function shareCount(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: number }[]>`SELECT (SELECT count(*) FROM bookmark_shares)::int + (SELECT count(*) FROM folder_shares)::int AS n`;
  });
  return rows[0]?.n ?? -1;
}

/** The source the world runs on, with the sharing entitlements it should withhold withheld before the first request, so no earlier answer is cached. */
function sourceWithholding(...keys: ("sharing.members" | "sharing.teams")[]): LimitedEntitlementSource {
  const source = new LimitedEntitlementSource();
  for (const key of keys) {
    source.deny(key);
  }
  return source;
}

describe("a workspace that holds neither sharing entitlement", () => {
  it(
    "is refused 403 entitlement_required on the search, the list, the grant to a member, the grant to a team and the revocation, with the upgrade the plan offers, and nothing is written",
    async () => {
      const source = new LimitedEntitlementSource();
      const world = harness.serve({ entitlementSource: source });
      const { owner, member, bookmark, folder, team } = await setup(world);
      const granted = await send(world, "POST", sharesPath(bookmark), { cookie: owner.cookie }, { accountId: member.account.id });
      expect(granted.status).toBe(201);
      const shareId = ((await granted.json()) as { id: string }).id;
      const folderGranted = await send(world, "POST", folderSharesPath(folder), { cookie: owner.cookie }, { accountId: member.account.id });
      expect(folderGranted.status).toBe(201);
      const folderShareId = ((await folderGranted.json()) as { id: string }).id;
      source.deny("sharing.members").deny("sharing.teams").offerUpgrade(true);
      // the plan changed: the workspace row's version moves, as `withEntitlementChange` moves it, so the next request reads the new values
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE workspaces SET entitlement_version = entitlement_version + 1`;
      });

      const refusals = [
        await send(world, "GET", TARGETS, { cookie: owner.cookie }),
        await send(world, "GET", sharesPath(bookmark), { cookie: owner.cookie }),
        await send(world, "POST", sharesPath(bookmark), { cookie: owner.cookie }, { accountId: owner.account.id }),
        await send(world, "POST", sharesPath(bookmark), { cookie: owner.cookie }, { teamId: team }),
        await send(world, "DELETE", `${sharesPath(bookmark)}/${shareId}`, { cookie: owner.cookie }),
        await send(world, "GET", folderSharesPath(folder), { cookie: owner.cookie }),
        await send(world, "POST", folderSharesPath(folder), { cookie: owner.cookie }, { accountId: owner.account.id }),
        await send(world, "POST", folderSharesPath(folder), { cookie: owner.cookie }, { teamId: team }),
        await send(world, "DELETE", `${folderSharesPath(folder)}/${folderShareId}`, { cookie: owner.cookie }),
      ];

      expect(refusals.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403]);
      const problems = await Promise.all(refusals.map(problemOf));
      expect(problems.map((problem) => [problem.code, problem.entitlement, problem.upgradeAvailable])).toEqual([
        ["entitlement_required", "sharing.members", true],
        ["entitlement_required", "sharing.members", true],
        ["entitlement_required", "sharing.members", true],
        ["entitlement_required", "sharing.teams", true],
        ["entitlement_required", "sharing.members", true],
        ["entitlement_required", "sharing.members", true],
        ["entitlement_required", "sharing.members", true],
        ["entitlement_required", "sharing.teams", true],
        ["entitlement_required", "sharing.members", true],
      ]);
      expect(await shareCount()).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "carries upgradeAvailable false when the source has no better plan to offer",
    async () => {
      const world = harness.serve({ entitlementSource: sourceWithholding("sharing.members", "sharing.teams") });
      const { owner, bookmark, folder } = await setup(world);
      const refused = await send(world, "GET", sharesPath(bookmark), { cookie: owner.cookie });
      expect(refused.status).toBe(403);
      expect(await problemOf(refused)).toMatchObject({ code: "entitlement_required", entitlement: "sharing.members", upgradeAvailable: false });
      const refusedFolder = await send(world, "GET", folderSharesPath(folder), { cookie: owner.cookie });
      expect(refusedFolder.status).toBe(403);
      expect(await problemOf(refusedFolder)).toMatchObject({ code: "entitlement_required", entitlement: "sharing.members", upgradeAvailable: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused the entitlement before the bookmark is looked up: a bookmark that is not the caller's is 403 too, which tells nothing about it",
    async () => {
      const world = harness.serve({ entitlementSource: sourceWithholding("sharing.members", "sharing.teams") });
      const { member, bookmark, folder } = await setup(world);
      const refused = await send(world, "GET", sharesPath(bookmark), { cookie: member.cookie });
      expect(refused.status).toBe(403);
      expect((await send(world, "GET", folderSharesPath(folder), { cookie: member.cookie })).status).toBe(403);
      expect((await send(world, "GET", folderSharesPath("0192f3a0-cccc-7000-8000-0000000000aa"), { cookie: member.cookie })).status).toBe(403);
      const unknown = await send(world, "GET", sharesPath("0192f3a0-cccc-7000-8000-0000000000aa"), { cookie: member.cookie });
      expect(unknown.status).toBe(403);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a workspace that holds sharing.members and not sharing.teams", () => {
  it(
    "shares with members, is refused a team with entitlement sharing.teams, offers members only, and lists and revokes",
    async () => {
      const source = sourceWithholding("sharing.teams").offerUpgrade(true);
      const world = harness.serve({ entitlementSource: source });
      const { owner, member, bookmark, folder, team } = await setup(world);

      const folderToMember = await send(world, "POST", folderSharesPath(folder), { cookie: owner.cookie }, { accountId: member.account.id });
      const folderToTeam = await send(world, "POST", folderSharesPath(folder), { cookie: owner.cookie }, { teamId: team });
      const folderListed = await send(world, "GET", folderSharesPath(folder), { cookie: owner.cookie });
      const folderRevoked = await send(world, "DELETE", `${folderSharesPath(folder)}/${((await folderToMember.json()) as { id: string }).id}`, { cookie: owner.cookie });
      const toMember = await send(world, "POST", sharesPath(bookmark), { cookie: owner.cookie }, { accountId: member.account.id });
      const toTeam = await send(world, "POST", sharesPath(bookmark), { cookie: owner.cookie }, { teamId: team });
      const offered = (await (await send(world, "GET", TARGETS, { cookie: owner.cookie })).json()) as { items: { kind: string }[] };
      const listed = await send(world, "GET", sharesPath(bookmark), { cookie: owner.cookie });
      const revoked = await send(world, "DELETE", `${sharesPath(bookmark)}/${((await toMember.json()) as { id: string }).id}`, { cookie: owner.cookie });

      expect(folderToMember.status).toBe(201);
      expect(folderToTeam.status).toBe(403);
      expect(await problemOf(folderToTeam)).toMatchObject({ code: "entitlement_required", entitlement: "sharing.teams", upgradeAvailable: true });
      expect(folderListed.status).toBe(200);
      expect(folderRevoked.status).toBe(204);
      expect(toMember.status).toBe(201);
      expect(toTeam.status).toBe(403);
      expect(await problemOf(toTeam)).toMatchObject({ code: "entitlement_required", entitlement: "sharing.teams", upgradeAvailable: true });
      expect(new Set(offered.items.map((item) => item.kind))).toEqual(new Set(["member"]));
      expect(listed.status).toBe(200);
      expect(revoked.status).toBe(204);
      expect(await shareCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a workspace that holds sharing.teams and not sharing.members", () => {
  it(
    "shares with teams, is refused a member with entitlement sharing.members, offers teams only, and lists and revokes",
    async () => {
      const world = harness.serve({ entitlementSource: sourceWithholding("sharing.members") });
      const { owner, member, bookmark, folder, team } = await setup(world);

      const folderToTeam = await send(world, "POST", folderSharesPath(folder), { cookie: owner.cookie }, { teamId: team });
      const folderToMember = await send(world, "POST", folderSharesPath(folder), { cookie: owner.cookie }, { accountId: member.account.id });
      const folderListed = (await (await send(world, "GET", folderSharesPath(folder), { cookie: owner.cookie })).json()) as { items: { kind: string }[] };
      const folderRevoked = await send(world, "DELETE", `${folderSharesPath(folder)}/${((await folderToTeam.json()) as { id: string }).id}`, { cookie: owner.cookie });
      const toTeam = await send(world, "POST", sharesPath(bookmark), { cookie: owner.cookie }, { teamId: team });
      const toMember = await send(world, "POST", sharesPath(bookmark), { cookie: owner.cookie }, { accountId: member.account.id });
      const offered = (await (await send(world, "GET", TARGETS, { cookie: owner.cookie })).json()) as { items: { kind: string }[] };
      const listed = (await (await send(world, "GET", sharesPath(bookmark), { cookie: owner.cookie })).json()) as { items: { kind: string }[] };
      const revoked = await send(world, "DELETE", `${sharesPath(bookmark)}/${((await toTeam.json()) as { id: string }).id}`, { cookie: owner.cookie });

      expect(folderToTeam.status).toBe(201);
      expect(folderToMember.status).toBe(403);
      expect(await problemOf(folderToMember)).toMatchObject({ code: "entitlement_required", entitlement: "sharing.members", upgradeAvailable: false });
      expect(folderListed.items.map((item) => item.kind)).toEqual(["team"]);
      expect(folderRevoked.status).toBe(204);
      expect(toTeam.status).toBe(201);
      expect(toMember.status).toBe(403);
      expect(await problemOf(toMember)).toMatchObject({ code: "entitlement_required", entitlement: "sharing.members", upgradeAvailable: false });
      expect(new Set(offered.items.map((item) => item.kind))).toEqual(new Set(["team"]));
      expect(listed.items.map((item) => item.kind)).toEqual(["team"]);
      expect(revoked.status).toBe(204);
      expect(await shareCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("an entitlement source that cannot answer", () => {
  it(
    "ends each of the seven operations with 503 and writes nothing: an error of the source is never a grant",
    async () => {
      const full = new LimitedEntitlementSource();
      let failing = false;
      const source: EntitlementSource = {
        available: true,
        forWorkspace: (workspaceId) => (failing ? Promise.reject(new PortUnavailable("entitlements", "unavailable")) : full.forWorkspace(workspaceId)),
        forAccount: (): Promise<AccountEntitlementValues> => Promise.resolve({ "workspaces.ownMax": "unlimited" } as unknown as AccountEntitlementValues),
      };
      const world = harness.serve({ entitlementSource: source });
      const { owner, member, bookmark, folder, team } = await setup(world);
      failing = true;
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE workspaces SET entitlement_version = entitlement_version + 1`;
      });

      const answers = [
        await send(world, "GET", TARGETS, { cookie: owner.cookie }),
        await send(world, "GET", sharesPath(bookmark), { cookie: owner.cookie }),
        await send(world, "POST", sharesPath(bookmark), { cookie: owner.cookie }, { accountId: member.account.id }),
        await send(world, "POST", sharesPath(bookmark), { cookie: owner.cookie }, { teamId: team }),
        await send(world, "DELETE", `${sharesPath(bookmark)}/0192f3a0-cccc-7000-8000-0000000000aa`, { cookie: owner.cookie }),
        await send(world, "GET", folderSharesPath(folder), { cookie: owner.cookie }),
        await send(world, "POST", folderSharesPath(folder), { cookie: owner.cookie }, { accountId: member.account.id }),
        await send(world, "POST", folderSharesPath(folder), { cookie: owner.cookie }, { teamId: team }),
        await send(world, "DELETE", `${folderSharesPath(folder)}/0192f3a0-cccc-7000-8000-0000000000aa`, { cookie: owner.cookie }),
      ];

      expect(answers.map((answer) => answer.status)).toEqual([503, 503, 503, 503, 503, 503, 503, 503, 503]);
      expect(await shareCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the bulk share and its preview (bulkBookmarks, previewBulkBookmarks)", () => {
  const bulkPath = `${BOOKMARKS}/bulk`;
  const bulkShare = (world: World, as: Person, bookmark: string, target: { accountId: string } | { teamId: string }, preview = false) =>
    send(world, "POST", preview ? `${bulkPath}/preview` : bulkPath, { cookie: as.cookie }, { action: "share", ids: [bookmark], ...target });

  it(
    "needs sharing.members for a member and sharing.teams for a team, whichever bookmarks are named, and the actions that share nothing need neither",
    async () => {
      const source = new LimitedEntitlementSource();
      const world = harness.serve({ entitlementSource: source });
      const { owner, member, bookmark, team } = await setup(world);
      source.deny("sharing.members").deny("sharing.teams").offerUpgrade(true);
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE workspaces SET entitlement_version = entitlement_version + 1`;
      });

      const refusals = [
        await bulkShare(world, owner, bookmark, { accountId: member.account.id }),
        await bulkShare(world, owner, bookmark, { teamId: team }),
        await bulkShare(world, owner, "0192f3a0-cccc-7000-8000-0000000000aa", { accountId: member.account.id }),
        await bulkShare(world, owner, bookmark, { accountId: member.account.id }, true),
        await bulkShare(world, owner, bookmark, { teamId: team }, true),
      ];

      expect(refusals.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
      const problems = await Promise.all(refusals.map(problemOf));
      expect(problems.map((problem) => [problem.code, problem.entitlement, problem.upgradeAvailable])).toEqual([
        ["entitlement_required", "sharing.members", true],
        ["entitlement_required", "sharing.teams", true],
        ["entitlement_required", "sharing.members", true],
        ["entitlement_required", "sharing.members", true],
        ["entitlement_required", "sharing.teams", true],
      ]);
      expect(await shareCount()).toBe(0);
      expect((await send(world, "POST", bulkPath, { cookie: owner.cookie }, { action: "pin", ids: [bookmark] })).status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "shares with members only when sharing.teams is withheld, and with teams only when sharing.members is",
    async () => {
      const membersOnly = harness.serve({ entitlementSource: sourceWithholding("sharing.teams") });
      const first = await setup(membersOnly);
      const toTeam = await bulkShare(membersOnly, first.owner, first.bookmark, { teamId: first.team });
      expect(toTeam.status).toBe(403);
      expect(await problemOf(toTeam)).toMatchObject({ code: "entitlement_required", entitlement: "sharing.teams" });
      expect((await bulkShare(membersOnly, first.owner, first.bookmark, { accountId: first.member.account.id })).status).toBe(200);
      expect(await shareCount()).toBe(1);

      await database().owner`TRUNCATE accounts CASCADE`;
      await database().owner`TRUNCATE workspaces CASCADE`;
      const teamsOnly = harness.serve({ entitlementSource: sourceWithholding("sharing.members") });
      const second = await setup(teamsOnly);
      const toMember = await bulkShare(teamsOnly, second.owner, second.bookmark, { accountId: second.member.account.id }, true);
      expect(toMember.status).toBe(403);
      expect(await problemOf(toMember)).toMatchObject({ code: "entitlement_required", entitlement: "sharing.members" });
      expect((await bulkShare(teamsOnly, second.owner, second.bookmark, { teamId: second.team }, true)).status).toBe(200);
      expect((await bulkShare(teamsOnly, second.owner, second.bookmark, { teamId: second.team })).status).toBe(200);
      expect(await shareCount()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ends with 503 and writes nothing when the entitlement source cannot answer: an error of the source is never a grant",
    async () => {
      const full = new LimitedEntitlementSource();
      let failing = false;
      const source: EntitlementSource = {
        available: true,
        forWorkspace: (workspaceId) => (failing ? Promise.reject(new PortUnavailable("entitlements", "unavailable")) : full.forWorkspace(workspaceId)),
        forAccount: (): Promise<AccountEntitlementValues> => Promise.resolve({ "workspaces.ownMax": "unlimited" } as unknown as AccountEntitlementValues),
      };
      const world = harness.serve({ entitlementSource: source });
      const { owner, member, bookmark, team } = await setup(world);
      failing = true;
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE workspaces SET entitlement_version = entitlement_version + 1`;
      });

      const answers = [
        await bulkShare(world, owner, bookmark, { accountId: member.account.id }),
        await bulkShare(world, owner, bookmark, { teamId: team }),
        await bulkShare(world, owner, bookmark, { accountId: member.account.id }, true),
        await bulkShare(world, owner, bookmark, { teamId: team }, true),
      ];

      expect(answers.map((answer) => answer.status)).toEqual([503, 503, 503, 503]);
      expect(await shareCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
