import { BOOKMARK_SORTS, dashboard, type BookmarkScope } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository, dashboardRepository, tagRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The sharing part of the dashboard (doc 02 section 9.3, doc 04 section 10.8, doc 05 section 4, doc 10 T2): the count of bookmarks shared with a member, the count of the member's own that are shared,
// and the forwarding bookmarks shared with the member in its quick access. The failure scenario: a count that includes a bookmark shared with another member, a bookmark of another workspace or a
// plan-archived one, or a quick access that names a bookmark the member cannot read, because the dashboard reads a rule of its own instead of the one the lists and `/go` read. Every count is held
// to the length of the list of its scope.

const HOOK_TIMEOUT_MS = 300_000;

let db: TestDatabase;
let workspaceId: string;
let elsewhere: string;
const people: Record<"owner" | "direct" | "teammate" | "viaFolder" | "outsider", string> = { owner: "", direct: "", teammate: "", viaFolder: "", outsider: "" };
const marks: Record<string, string> = {};

async function bookmark(workspace: string, ownerId: string, name: string, extra: { slug?: string; forwarding?: boolean; archived?: boolean; openCount?: number } = {}): Promise<string> {
  const id = freshId();
  marks[name] = id;
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, plan_archived_at, open_count)
      VALUES (${id}, ${workspace}, ${ownerId}, ${`https://example.com/${name}`}, ${`https://example.com/${name}`}, 'example.com', ${name}, ${extra.slug ?? null}, ${extra.forwarding ?? false},
              ${extra.archived === true ? new Date() : null}, ${extra.openCount ?? 0})`,
  );
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  workspaceId = await seedWorkspace(db, { name: "Dashboard sharing test" });
  elsewhere = await seedWorkspace(db, { name: "Dashboard sharing test, elsewhere" });
  for (const name of Object.keys(people) as (keyof typeof people)[]) {
    people[name] = freshId();
    await seedAccount(db, { id: people[name], email: `dashboard-sharing-${name}@example.test`, passwordHash: "$argon2id$stub" });
    await seedMember(db, { workspaceId, accountId: people[name], role: name === "owner" ? "owner" : "member" });
    await seedMember(db, { workspaceId: elsewhere, accountId: people[name], role: name === "owner" ? "owner" : "member" });
  }
  const { owner, direct, teammate, viaFolder } = people;
  // What the owner has: forwarding bookmarks shared in each way, one nobody can read, an archived one, one that does not forward, and one of the workspace elsewhere.
  await bookmark(workspaceId, owner, "to-direct", { slug: "to-direct", forwarding: true, openCount: 40 });
  await bookmark(workspaceId, owner, "to-team", { slug: "to-team", forwarding: true, openCount: 30 });
  await bookmark(workspaceId, owner, "to-folder", { slug: "to-folder", forwarding: true, openCount: 20 });
  await bookmark(workspaceId, owner, "private", { slug: "private", forwarding: true, openCount: 99 });
  await bookmark(workspaceId, owner, "archived", { slug: "archived", forwarding: true, archived: true, openCount: 99 });
  await bookmark(workspaceId, owner, "plain", { openCount: 99 });
  await bookmark(elsewhere, owner, "far", { slug: "far", forwarding: true, openCount: 99 });
  // What the member that is shared with has of its own.
  await bookmark(workspaceId, direct, "mine-low", { slug: "mine-low", forwarding: true, openCount: 5 });
  await bookmark(workspaceId, direct, "mine-high", { slug: "mine-high", forwarding: true, openCount: 35 });
  await bookmark(workspaceId, direct, "mine-shared", { slug: "mine-shared", forwarding: true, openCount: 1 });
  const team = freshId();
  const folder = freshId();
  await asSystem(db, async (tx) => {
    await tx`INSERT INTO teams (id, workspace_id, name) VALUES (${team}, ${workspaceId}, 'Readers')`;
    await tx`INSERT INTO team_members (workspace_id, team_id, account_id) VALUES (${workspaceId}, ${team}, ${direct}), (${workspaceId}, ${team}, ${teammate})`;
    await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${folder}, ${workspaceId}, ${owner}, 'Shared folder')`;
    await tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspaceId}, ${folder}, ${marks["to-folder"] ?? ""}), (${workspaceId}, ${folder}, ${marks["plain"] ?? ""})`;
    await tx`
      INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, target_team_id, granted_by) VALUES
        (${freshId()}, ${workspaceId}, ${marks["to-direct"] ?? ""}, ${direct}, NULL, ${owner}),
        (${freshId()}, ${workspaceId}, ${marks["to-team"] ?? ""}, NULL, ${team}, ${owner}),
        (${freshId()}, ${workspaceId}, ${marks["archived"] ?? ""}, ${direct}, NULL, ${owner}),
        (${freshId()}, ${workspaceId}, ${marks["mine-shared"] ?? ""}, ${owner}, NULL, ${direct})`;
    await tx`INSERT INTO folder_shares (id, workspace_id, folder_id, target_account_id, granted_by) VALUES (${freshId()}, ${workspaceId}, ${folder}, ${viaFolder}, ${owner}), (${freshId()}, ${workspaceId}, ${folder}, ${direct}, ${owner})`;
    // A share of the workspace elsewhere to the member, which gives nothing here.
    await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${freshId()}, ${elsewhere}, ${marks["far"] ?? ""}, ${direct}, ${owner})`;
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

function asMember<T>(accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "dashboard-sharing-test" }, work);
}

const dashboardOf = (accountId: string, sharing: boolean) => asMember(accountId, (tx) => dashboard({ store: dashboardRepository(tx), tags: tagRepository(tx) }, { accountId, sharing }));

async function listed(accountId: string, scope: BookmarkScope): Promise<string[]> {
  const rows = await asMember(accountId, (tx) => bookmarkRepository(tx).list({ filter: { ownerId: accountId, scope }, sort: BOOKMARK_SORTS[0], after: undefined, limit: 100 }));
  return rows.map((row) => row.bookmark.id);
}

describe("the sharing counts", () => {
  it("count the bookmarks shared with the member by every route, each once, and none shared with someone else, plan-archived or of another workspace", async () => {
    // direct: to-direct (directly), to-team (through the team), to-folder and plain (through the folder shared with the member); the archived one is not counted.
    expect((await dashboardOf(people.direct, true))?.sharing).toEqual({ sharedWithYou: 4, sharedByYou: 1 });
    // teammate: only the team's. viaFolder: only the folder's. outsider: nothing.
    expect((await dashboardOf(people.teammate, true))?.sharing).toEqual({ sharedWithYou: 1, sharedByYou: 0 });
    expect((await dashboardOf(people.viaFolder, true))?.sharing).toEqual({ sharedWithYou: 2, sharedByYou: 0 });
    expect((await dashboardOf(people.outsider, true))?.sharing).toEqual({ sharedWithYou: 0, sharedByYou: 0 });
  });

  it("count the owner's own bookmarks that are shared, directly or through a folder, and not the one shared with the owner", async () => {
    // to-direct, to-team, to-folder and plain (filed in a shared folder); not private, the archived one or the one the other member shared with the owner.
    expect((await dashboardOf(people.owner, true))?.sharing).toEqual({ sharedWithYou: 1, sharedByYou: 4 });
  });

  it("agree with the length of the list of their scope for every member", async () => {
    for (const accountId of Object.values(people)) {
      const answer = await dashboardOf(accountId, true);

      expect(answer?.sharing, accountId).toEqual({ sharedWithYou: (await listed(accountId, "shared_with_me")).length, sharedByYou: (await listed(accountId, "shared_by_me")).length });
      expect(answer?.counts.sharedWithYou, accountId).toBe(answer?.sharing?.sharedWithYou);
    }
  });

  it("are neither read nor answered where the workspace does not hold the sharing entitlements", async () => {
    const answer = await dashboardOf(people.direct, false);

    expect(answer?.sharing).toBeNull();
    expect(answer?.counts.sharedWithYou).toBeNull();
  });

  it("are read for the account of the transaction only", async () => {
    await expect(asMember(people.direct, (tx) => dashboardRepository(tx).sharedCounts(people.owner))).rejects.toThrow(/account of the transaction/);
  });
});

describe("the quick access with shared bookmarks", () => {
  it("holds the readable forwarding bookmarks shared with the member beside its own, the most opened first", async () => {
    const answer = await dashboardOf(people.direct, true);

    // 40 shared directly, 35 own, 30 through the team, 20 through the folder, 5 own, 1 own; the archived share, the plain one and the other workspace's are not in it.
    expect(answer?.quickAccess.map((entry) => entry.title)).toEqual(["to-direct", "mine-high", "to-team", "to-folder", "mine-low", "mine-shared"]);
    expect(answer?.quickAccess[0]).toEqual({ id: marks["to-direct"], title: "to-direct", url: "https://example.com/to-direct", host: "example.com", slug: "to-direct", forwarding: true, openCount: 40 });
  });

  it("is the same with or without the sharing entitlements: reading a bookmark is not an entitlement", async () => {
    expect((await dashboardOf(people.direct, false))?.quickAccess.map((entry) => entry.title)).toEqual(["to-direct", "mine-high", "to-team", "to-folder", "mine-low", "mine-shared"]);
  });

  it("never names a bookmark the member cannot read, a plan-archived one, or one that does not forward", async () => {
    for (const accountId of [people.teammate, people.viaFolder, people.outsider]) {
      const titles = (await dashboardOf(accountId, true))?.quickAccess.map((entry) => entry.title) ?? [];

      expect(titles, accountId).not.toContain("private");
      expect(titles, accountId).not.toContain("archived");
      expect(titles, accountId).not.toContain("plain");
      expect(titles, accountId).not.toContain("far");
    }
    expect((await dashboardOf(people.teammate, true))?.quickAccess.map((entry) => entry.title)).toEqual(["to-team"]);
    expect((await dashboardOf(people.viaFolder, true))?.quickAccess.map((entry) => entry.title)).toEqual(["to-folder"]);
    expect((await dashboardOf(people.outsider, true))?.quickAccess).toEqual([]);
  });

  it("holds at most the limit, taking the most opened of the own and of the shared bookmarks together", async () => {
    const entries = await asMember(people.direct, (tx) => dashboardRepository(tx).quickAccess(people.direct, 2));

    expect(entries.map((entry) => entry.title)).toEqual(["to-direct", "mine-high"]);
  });
});
