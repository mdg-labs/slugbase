import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedTeam, shareBookmark, shareThroughFolder } from "./support/share-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The remembered choices of a member who lost access to the bookmark (doc 02 sections 3.6 and 6.4, doc 05 section 2.6, doc 10 T2; src/sql/670-slug-preference-cleanup.sql). The failure
// scenario: B has a remembered choice for `mail` on A's bookmark, shared through a team; B is removed from the team; the choice is deleted in the transaction that removes B, and not
// when B next resolves the slug. Each row of the table ends the access by deleting the rows of one table, as the statements of the operations do, and every row is asserted twice:
// the choice is gone when the member has no other route, and stays when they have one. The trigger judges the state the transaction leaves at its end.

const HOOK_TIMEOUT_MS = 300_000;
const SLUG = "mail";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `cleanup${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

async function bookmarkOf(workspaceId: string, ownerId: string): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
      VALUES (${id}, ${workspaceId}, ${ownerId}, 'https://example.com/a', 'https://example.com/a', 'example.com', 'Mail', ${SLUG}, true)`,
  );
  return id;
}

async function remember(workspaceId: string, accountId: string, bookmarkId: string): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${workspaceId}, ${accountId}, ${SLUG}, ${bookmarkId})`);
}

async function choicesIn(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ account_id: string }[]>`SELECT account_id FROM slug_preferences WHERE workspace_id = ${workspaceId} ORDER BY account_id`);
  return rows.map((row) => row.account_id);
}

interface World {
  readonly workspaceId: string;
  /** Owns the bookmark. */
  readonly owner: string;
  /** Has the choice. */
  readonly member: string;
  /** Another member, who reads the bookmark by a route of their own and has a choice too. */
  readonly bystander: string;
  readonly bookmark: string;
}

async function world(): Promise<World> {
  const workspaceId = await seedWorkspace(db, { name: "Cleanup" });
  const [owner, member, bystander] = [await account(), await account(), await account()];
  await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
  await seedMember(db, { workspaceId, accountId: member, role: "member" });
  await seedMember(db, { workspaceId, accountId: bystander, role: "member" });
  const bookmark = await bookmarkOf(workspaceId, owner);
  return { workspaceId, owner, member, bystander, bookmark };
}

interface Route {
  /** The statements, as slugbase_system, that take the route away. */
  readonly end: (tx: Parameters<Parameters<typeof asSystem>[1]>[0], world: World) => Promise<unknown>;
}

interface Way {
  readonly name: string;
  /** The other route the member has in the case that keeps the choice: one the way does not end. */
  readonly other: "direct" | "team";
  /** Gives the member a route and answers how it ends. */
  readonly give: (world: World) => Promise<Route>;
}

const WAYS: readonly Way[] = [
  {
    name: "a direct share is deleted",
    other: "team",
    give: async (w) => {
      await shareBookmark(db, w.workspaceId, w.bookmark, w.owner, { accountId: w.member });
      return { end: (tx, x) => tx`DELETE FROM bookmark_shares WHERE bookmark_id = ${x.bookmark} AND target_account_id = ${x.member}` };
    },
  },
  {
    name: "a share with the member's team is deleted",
    other: "direct",
    give: async (w) => {
      const team = await seedTeam(db, w.workspaceId, [w.member]);
      await shareBookmark(db, w.workspaceId, w.bookmark, w.owner, { teamId: team });
      return { end: (tx, x) => tx`DELETE FROM bookmark_shares WHERE bookmark_id = ${x.bookmark} AND target_team_id = ${team}` };
    },
  },
  {
    name: "the member is taken out of the team",
    other: "direct",
    give: async (w) => {
      const team = await seedTeam(db, w.workspaceId, [w.member]);
      await shareBookmark(db, w.workspaceId, w.bookmark, w.owner, { teamId: team });
      return { end: (tx, x) => tx`DELETE FROM team_members WHERE team_id = ${team} AND account_id = ${x.member}` };
    },
  },
  {
    name: "the team is deleted",
    other: "direct",
    give: async (w) => {
      const team = await seedTeam(db, w.workspaceId, [w.member]);
      await shareBookmark(db, w.workspaceId, w.bookmark, w.owner, { teamId: team });
      return { end: (tx) => tx`DELETE FROM teams WHERE id = ${team}` };
    },
  },
  {
    name: "the bookmark is taken out of a folder shared with the member",
    other: "direct",
    give: async (w) => {
      const folder = await shareThroughFolder(db, w.workspaceId, w.bookmark, w.owner, { accountId: w.member });
      return { end: (tx, x) => tx`DELETE FROM folder_bookmarks WHERE folder_id = ${folder} AND bookmark_id = ${x.bookmark}` };
    },
  },
  {
    name: "a folder share with the member's team is deleted",
    other: "direct",
    give: async (w) => {
      const team = await seedTeam(db, w.workspaceId, [w.member]);
      const folder = await shareThroughFolder(db, w.workspaceId, w.bookmark, w.owner, { teamId: team });
      return { end: (tx) => tx`DELETE FROM folder_shares WHERE folder_id = ${folder}` };
    },
  },
  {
    name: "the shared folder is deleted",
    other: "direct",
    give: async (w) => {
      const folder = await shareThroughFolder(db, w.workspaceId, w.bookmark, w.owner, { accountId: w.member });
      return { end: (tx) => tx`DELETE FROM folders WHERE id = ${folder}` };
    },
  },
];

/** Gives the member a route of the kind, which no way ends by the rows it deletes. */
async function otherRoute(w: World, kind: "direct" | "team"): Promise<void> {
  if (kind === "direct") {
    await shareBookmark(db, w.workspaceId, w.bookmark, w.owner, { accountId: w.member });
    return;
  }
  const team = await seedTeam(db, w.workspaceId, [w.member]);
  await shareBookmark(db, w.workspaceId, w.bookmark, w.owner, { teamId: team });
}

describe.each(WAYS)("when $name", ({ give, other }) => {
  it("deletes the member's choice in the transaction, and leaves the choice of a member who still reads the bookmark", async () => {
    const w = await world();
    const route = await give(w);
    await shareBookmark(db, w.workspaceId, w.bookmark, w.owner, { accountId: w.bystander });
    await remember(w.workspaceId, w.member, w.bookmark);
    await remember(w.workspaceId, w.bystander, w.bookmark);

    await asSystem(db, (tx) => route.end(tx, w));

    expect(await choicesIn(w.workspaceId)).toEqual([w.bystander]);
  });

  it("keeps the member's choice while another route reads the bookmark", async () => {
    const w = await world();
    const route = await give(w);
    await otherRoute(w, other);
    await remember(w.workspaceId, w.member, w.bookmark);

    await asSystem(db, (tx) => route.end(tx, w));

    expect(await choicesIn(w.workspaceId)).toEqual([w.member]);
  });
});

describe("the trigger", () => {
  it("judges the state the transaction leaves: a share deleted and granted again in one transaction keeps the choice", async () => {
    const w = await world();
    await shareBookmark(db, w.workspaceId, w.bookmark, w.owner, { accountId: w.member });
    await remember(w.workspaceId, w.member, w.bookmark);

    await asSystem(db, async (tx) => {
      await tx`DELETE FROM bookmark_shares WHERE bookmark_id = ${w.bookmark} AND target_account_id = ${w.member}`;
      await tx`INSERT INTO bookmark_shares (id, workspace_id, bookmark_id, target_account_id, granted_by) VALUES (${freshId()}, ${w.workspaceId}, ${w.bookmark}, ${w.member}, ${w.owner})`;
    });

    expect(await choicesIn(w.workspaceId)).toEqual([w.member]);
  });

  it("keeps the choice when the transaction that deleted the share does not commit", async () => {
    const w = await world();
    await shareBookmark(db, w.workspaceId, w.bookmark, w.owner, { accountId: w.member });
    await remember(w.workspaceId, w.member, w.bookmark);

    await expect(
      asSystem(db, async (tx) => {
        await tx`DELETE FROM bookmark_shares WHERE bookmark_id = ${w.bookmark} AND target_account_id = ${w.member}`;
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    expect(await choicesIn(w.workspaceId)).toEqual([w.member]);
  });

  it("leaves the choices of the same account and slug in another workspace", async () => {
    const w = await world();
    const elsewhere = await seedWorkspace(db, { name: "Elsewhere" });
    await seedMember(db, { workspaceId: elsewhere, accountId: w.member, role: "member" });
    const theirOwner = await account();
    await seedMember(db, { workspaceId: elsewhere, accountId: theirOwner, role: "owner" });
    const theirBookmark = await bookmarkOf(elsewhere, theirOwner);
    await shareBookmark(db, w.workspaceId, w.bookmark, w.owner, { accountId: w.member });
    await shareBookmark(db, elsewhere, theirBookmark, theirOwner, { accountId: w.member });
    await remember(w.workspaceId, w.member, w.bookmark);
    await remember(elsewhere, w.member, theirBookmark);

    await asSystem(db, (tx) => tx`DELETE FROM bookmark_shares WHERE bookmark_id = ${w.bookmark}`);

    expect(await choicesIn(w.workspaceId)).toEqual([]);
    expect(await choicesIn(elsewhere)).toEqual([w.member]);
  });

  it("deletes the choice of a member who leaves along with the shares they received, and keeps the owner's own", async () => {
    const w = await world();
    await shareBookmark(db, w.workspaceId, w.bookmark, w.owner, { accountId: w.member });
    await remember(w.workspaceId, w.member, w.bookmark);
    await remember(w.workspaceId, w.owner, w.bookmark);

    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${w.workspaceId} AND account_id = ${w.member}`);

    expect(await choicesIn(w.workspaceId)).toEqual([w.owner]);
    const shares = await asSystem(db, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmark_shares WHERE target_account_id = ${w.member}`);
    expect(shares[0]?.n).toBe(0);
  });
});
