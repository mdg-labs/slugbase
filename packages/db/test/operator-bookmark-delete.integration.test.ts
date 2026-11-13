import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goRepository } from "../src/index.ts";
import { tenantHandle } from "../src/tenant.ts";
import { operatorSystemOperations, systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedTeam, shareBookmark } from "./support/share-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The removal of one bookmark by whoever holds the database (doc 05 sections 2.2, 2.9 and 3.3, doc 10 section 2.10, T1, T2, T11 and T15). The failure
// scenario: a bookmark whose owner has left has no owner, so sys_bookmark_delete answers false for every member and the operator has no supported way to
// remove it; a plain DELETE would leave workspaces.bookmark_count above the rows and record nothing. sys_bookmark_operator_delete removes the bookmark
// whoever owns it, lowers the counter exactly as sys_bookmark_delete does, writes the audit event in the same transaction, and is out of reach of the
// application role: the migration login reaches it with SET ROLE slugbase_system and nothing else does. The operator page is run in
// packages/testing/test/operator-bookmark-delete-page.integration.test.ts.

const HOOK_TIMEOUT_MS = 300_000;
const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PARAMETER_VALUE = "22023";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const REASON = "Court order, ref. 2026-123";

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
  await seedAccount(db, { id, email: `operator-delete${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  return id;
}

interface Workspace {
  readonly id: string;
  /** The members, the first of them the owner. */
  readonly members: readonly string[];
}

async function workspaceOf(memberCount = 2): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Operator delete test" });
  const members: string[] = [];
  for (let index = 0; index < memberCount; index += 1) {
    const accountId = await account();
    await seedMember(db, { workspaceId: id, accountId, role: index === 0 ? "owner" : "member" });
    members.push(accountId);
  }
  return { id, members };
}

function memberOf(workspace: Workspace, index: number): string {
  const member = workspace.members[index];
  if (member === undefined) {
    throw new Error("no such member");
  }
  return member;
}

interface SeedBookmark {
  readonly workspaceId: string;
  readonly ownerId?: string | null;
  readonly slug?: string | null;
  readonly forwarding?: boolean;
  readonly planArchivedAt?: Date | null;
}

/** Writes a bookmark as slugbase_system and raises the counter with it when the bookmark counts, so that the counter and the rows agree. */
async function seedBookmark(bookmark: SeedBookmark): Promise<string> {
  const id = freshId();
  await asSystem(db, async (tx) => {
    await tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, plan_archived_at)
      VALUES (${id}, ${bookmark.workspaceId}, ${bookmark.ownerId ?? null}, 'https://example.com/seed', 'https://example.com/seed', 'example.com', 'Seed',
              ${bookmark.slug ?? null}, ${bookmark.forwarding ?? false}, ${bookmark.planArchivedAt ?? null})`;
    if (bookmark.planArchivedAt === undefined || bookmark.planArchivedAt === null) {
      await tx`UPDATE workspaces SET bookmark_count = bookmark_count + 1 WHERE id = ${bookmark.workspaceId}`;
    }
  });
  return id;
}

async function bookmarkCount(workspaceId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}`);
  return rows[0]?.bookmark_count ?? Number.NaN;
}

async function storedRows(workspaceId: string): Promise<number> {
  const rows = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM bookmarks WHERE workspace_id = ${workspaceId}`);
  return Number(rows[0]?.n);
}

async function bookmarkExists(bookmarkId: string): Promise<boolean> {
  const rows = await asSystem(db, (tx) => tx<{ n: string }[]>`SELECT count(*)::text AS n FROM bookmarks WHERE id = ${bookmarkId}`);
  return Number(rows[0]?.n) === 1;
}

/** Every workspace whose counter differs from its rows that are not plan-archived, which the end of each test holds empty (doc 05 section 2.2). */
async function assertCounterMatches(): Promise<void> {
  const drifted = await asSystem(
    db,
    (tx) => tx<{ id: string; counter: number; rows: number }[]>`
      SELECT w.id, w.bookmark_count AS counter,
             (SELECT count(*) FROM bookmarks b WHERE b.workspace_id = w.id AND b.plan_archived_at IS NULL)::int AS rows
      FROM workspaces w
      WHERE w.bookmark_count <> (SELECT count(*) FROM bookmarks b WHERE b.workspace_id = w.id AND b.plan_archived_at IS NULL)`,
  );
  expect(drifted).toEqual([]);
}

interface EventRow {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly actor_type: string;
  readonly actor_account_id: string | null;
  readonly actor_label: string;
  readonly actor_token_id: string | null;
  readonly action: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly metadata: Record<string, string>;
  readonly ip_prefix: string | null;
}

async function eventsOf(workspaceId: string): Promise<EventRow[]> {
  const rows = await asSystem(
    db,
    (tx) => tx<EventRow[]>`
      SELECT id, workspace_id, actor_type, actor_account_id, actor_label, actor_token_id, action, entity_type, entity_id, metadata, host(ip_prefix) AS ip_prefix
      FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`,
  );
  return [...rows];
}

/** Runs the statement the way the operator page does: as the migration login after SET LOCAL ROLE slugbase_system. */
async function operatorDelete(workspaceId: string | null, bookmarkId: string | null, reason: string | null = REASON, eventId: string | null = freshId()): Promise<boolean> {
  const rows = await db.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ removed: boolean }[]>`SELECT sys_bookmark_operator_delete(${workspaceId}::uuid, ${bookmarkId}::uuid, ${eventId}::uuid, ${reason}::text) AS removed`;
  });
  return rows[0]?.removed ?? false;
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

async function failureCode(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string") {
        return code;
      }
      current = cause;
    }
    throw error;
  }
  return undefined;
}

/** What `sys_bookmark_delete` answers a member who names the bookmark in the workspace the transaction acts in. */
function memberDeletes(workspaceId: string, accountId: string, bookmarkId: string): Promise<boolean | undefined> {
  return appAs({ accountId, workspaceId }, (tx) => tx<{ deleted: boolean }[]>`SELECT sys_bookmark_delete(${workspaceId}::uuid, ${bookmarkId}::uuid) AS deleted`).then((rows) => rows[0]?.deleted);
}

describe("the function", () => {
  it("is a registered operator system operation of the system operation registry", () => {
    expect(systemOperations).toContain("sys_bookmark_operator_delete");
    expect(operatorSystemOperations).toEqual(["sys_bookmark_operator_delete"]);
  });

  it("is SECURITY DEFINER, owned by slugbase_system, with the pinned search_path, and no grant but its owner's", async () => {
    const [row] = await db.owner<{ definer: boolean; owner: string; config: string[]; acl: string[] | null }[]>`
      SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, p.proacl::text[] AS acl
      FROM pg_proc p WHERE p.oid = 'public.sys_bookmark_operator_delete(uuid, uuid, uuid, text)'::regprocedure`;
    expect(row?.definer).toBe(true);
    expect(row?.owner).toBe("slugbase_system");
    expect(row?.config).toEqual(["search_path=pg_catalog, public, pg_temp"]);
    expect(row?.acl).toEqual(["slugbase_system=X/slugbase_system"]);
  });
});

describe("the removal of a bookmark that has no owner", () => {
  it("removes what sys_bookmark_delete cannot, lowers the counter by one and writes the event (the reported failure)", async () => {
    const workspace = await workspaceOf(2);
    const ownerless = await seedBookmark({ workspaceId: workspace.id, ownerId: null });
    const kept = await seedBookmark({ workspaceId: workspace.id, ownerId: memberOf(workspace, 0) });
    await assertCounterMatches();

    // The member's own delete finds nothing to remove, for the owner of the workspace and for another member alike.
    expect(await memberDeletes(workspace.id, memberOf(workspace, 0), ownerless)).toBe(false);
    expect(await memberDeletes(workspace.id, memberOf(workspace, 1), ownerless)).toBe(false);
    expect(await bookmarkExists(ownerless)).toBe(true);
    expect(await bookmarkCount(workspace.id)).toBe(2);

    const eventId = freshId();
    expect(await operatorDelete(workspace.id, ownerless, REASON, eventId)).toBe(true);

    expect(await bookmarkExists(ownerless)).toBe(false);
    expect(await bookmarkExists(kept)).toBe(true);
    expect(await bookmarkCount(workspace.id)).toBe(1);
    expect(await eventsOf(workspace.id)).toEqual([
      {
        id: eventId,
        workspace_id: workspace.id,
        actor_type: "system",
        actor_account_id: null,
        actor_label: "slugbase_migrator",
        actor_token_id: null,
        action: "bookmark.operator_deleted",
        entity_type: "bookmark",
        entity_id: ownerless,
        metadata: { reason: REASON },
        ip_prefix: null,
      },
    ]);
    await assertCounterMatches();
  });

  it("answers false for the bookmark once it is gone, and writes nothing the second time", async () => {
    const workspace = await workspaceOf(1);
    const ownerless = await seedBookmark({ workspaceId: workspace.id, ownerId: null });

    expect(await operatorDelete(workspace.id, ownerless)).toBe(true);
    expect(await operatorDelete(workspace.id, ownerless)).toBe(false);

    expect(await eventsOf(workspace.id)).toHaveLength(1);
    expect(await bookmarkCount(workspace.id)).toBe(0);
    await assertCounterMatches();
  });
});

describe("the removal of a bookmark that has an owner", () => {
  it("removes an owned bookmark, lowers the counter by one and records it", async () => {
    const workspace = await workspaceOf(2);
    const owned = await seedBookmark({ workspaceId: workspace.id, ownerId: memberOf(workspace, 1) });
    await seedBookmark({ workspaceId: workspace.id, ownerId: memberOf(workspace, 1) });

    expect(await operatorDelete(workspace.id, owned)).toBe(true);

    expect(await bookmarkExists(owned)).toBe(false);
    expect(await storedRows(workspace.id)).toBe(1);
    expect(await bookmarkCount(workspace.id)).toBe(1);
    expect((await eventsOf(workspace.id)).map((event) => [event.action, event.entity_id])).toEqual([["bookmark.operator_deleted", owned]]);
    await assertCounterMatches();
  });

  it("removes a plan-archived bookmark and leaves the counter, which never counted it", async () => {
    const workspace = await workspaceOf(1);
    const archived = await seedBookmark({ workspaceId: workspace.id, ownerId: memberOf(workspace, 0), planArchivedAt: new Date() });
    await seedBookmark({ workspaceId: workspace.id, ownerId: memberOf(workspace, 0) });
    expect(await bookmarkCount(workspace.id)).toBe(1);

    expect(await operatorDelete(workspace.id, archived)).toBe(true);

    expect(await bookmarkExists(archived)).toBe(false);
    expect(await storedRows(workspace.id)).toBe(1);
    expect(await bookmarkCount(workspace.id)).toBe(1);
    expect(await eventsOf(workspace.id)).toHaveLength(1);
    await assertCounterMatches();
  });

  it("fails the call, and keeps the row and the event unwritten, when the counter disagrees with the rows and would fall below zero", async () => {
    const workspace = await workspaceOf(1);
    const owned = await seedBookmark({ workspaceId: workspace.id, ownerId: memberOf(workspace, 0) });
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = 0 WHERE id = ${workspace.id}`);

    expect(await failureCode(operatorDelete(workspace.id, owned))).toBe(CHECK_VIOLATION);

    expect(await bookmarkExists(owned)).toBe(true);
    expect(await bookmarkCount(workspace.id)).toBe(0);
    expect(await eventsOf(workspace.id)).toEqual([]);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = 1 WHERE id = ${workspace.id}`);
  });
});

describe("what goes with the bookmark", () => {
  it("removes the slug, the shares, the filing, the tag link and the remembered /go choice, so that /go/<slug> finds nothing", async () => {
    const workspace = await workspaceOf(3);
    const [owner, sharedMember, otherMember] = [memberOf(workspace, 0), memberOf(workspace, 1), memberOf(workspace, 2)];
    const team = await seedTeam(db, workspace.id, [otherMember]);
    const bookmark = await seedBookmark({ workspaceId: workspace.id, ownerId: owner, slug: "mail", forwarding: true });
    const survivor = await seedBookmark({ workspaceId: workspace.id, ownerId: owner, slug: "docs", forwarding: true });
    await shareBookmark(db, workspace.id, bookmark, owner, { accountId: sharedMember });
    await shareBookmark(db, workspace.id, bookmark, owner, { teamId: team });
    const folder = freshId();
    const tag = freshId();
    await asSystem(db, async (tx) => {
      await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${folder}, ${workspace.id}, ${owner}, 'Mail')`;
      await tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspace.id}, ${folder}, ${bookmark}), (${workspace.id}, ${folder}, ${survivor})`;
      await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${tag}, ${workspace.id}, ${owner}, 'inbox')`;
      await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${workspace.id}, ${bookmark}, ${tag}), (${workspace.id}, ${survivor}, ${tag})`;
      await tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${workspace.id}, ${owner}, 'mail', ${bookmark}), (${workspace.id}, ${owner}, 'docs', ${survivor})`;
    });
    const resolve = (accountId: string, slug: string) =>
      db.tenant.withTenant({ accountId, workspaceId: workspace.id, requestId: "operator-delete-test" }, (tx) => goRepository(tx).candidates({ slug, accountId }));
    expect((await resolve(owner, "mail")).candidates.map((candidate) => candidate.id)).toEqual([bookmark]);
    expect((await resolve(sharedMember, "mail")).candidates.map((candidate) => candidate.id)).toEqual([bookmark]);

    expect(await operatorDelete(workspace.id, bookmark)).toBe(true);

    const rows = await asSystem(
      db,
      (tx) => tx<{ shares: string; filings: string; tag_links: string; preferences: string }[]>`
        SELECT (SELECT count(*) FROM bookmark_shares WHERE bookmark_id = ${bookmark})::text AS shares,
               (SELECT count(*) FROM folder_bookmarks WHERE bookmark_id = ${bookmark})::text AS filings,
               (SELECT count(*) FROM bookmark_tags WHERE bookmark_id = ${bookmark})::text AS tag_links,
               (SELECT count(*) FROM slug_preferences WHERE bookmark_id = ${bookmark})::text AS preferences`,
    );
    expect(rows).toEqual([{ shares: "0", filings: "0", tag_links: "0", preferences: "0" }]);
    for (const accountId of [owner, sharedMember, otherMember]) {
      expect((await resolve(accountId, "mail")).candidates, `the candidates of /go/mail for ${accountId}`).toEqual([]);
    }
    // The bookmark that stays keeps its filing, its tag link and its remembered choice, and its slug still resolves.
    expect((await resolve(owner, "docs")).candidates.map((candidate) => candidate.id)).toEqual([survivor]);
    const kept = await asSystem(
      db,
      (tx) => tx<{ filings: string; tag_links: string; preferences: string }[]>`
        SELECT (SELECT count(*) FROM folder_bookmarks WHERE bookmark_id = ${survivor})::text AS filings,
               (SELECT count(*) FROM bookmark_tags WHERE bookmark_id = ${survivor})::text AS tag_links,
               (SELECT count(*) FROM slug_preferences WHERE bookmark_id = ${survivor})::text AS preferences`,
    );
    expect(kept).toEqual([{ filings: "1", tag_links: "1", preferences: "1" }]);
    await assertCounterMatches();
  });

  it("removes the slug of an ownerless bookmark for every member of the workspace", async () => {
    const workspace = await workspaceOf(2);
    const ownerless = await seedBookmark({ workspaceId: workspace.id, ownerId: null, slug: "legal", forwarding: true });
    await shareBookmark(db, workspace.id, ownerless, memberOf(workspace, 0), { accountId: memberOf(workspace, 1) });
    const resolve = (accountId: string) =>
      db.tenant.withTenant({ accountId, workspaceId: workspace.id, requestId: "operator-delete-test" }, (tx) => goRepository(tx).candidates({ slug: "legal", accountId }));
    expect((await resolve(memberOf(workspace, 1))).candidates.map((candidate) => candidate.id)).toEqual([ownerless]);

    expect(await operatorDelete(workspace.id, ownerless)).toBe(true);

    for (const index of [0, 1]) {
      expect((await resolve(memberOf(workspace, index))).candidates).toEqual([]);
    }
    await assertCounterMatches();
  });
});

describe("the bookmarks it refuses to touch", () => {
  it("answers false and changes nothing for the right bookmark in another workspace, for an unknown identifier and for a workspace that does not exist", async () => {
    const a = await workspaceOf(1);
    const b = await workspaceOf(1);
    const ofA = await seedBookmark({ workspaceId: a.id, ownerId: memberOf(a, 0) });
    const ofB = await seedBookmark({ workspaceId: b.id, ownerId: null });

    expect(await operatorDelete(a.id, ofB)).toBe(false);
    expect(await operatorDelete(b.id, ofA)).toBe(false);
    expect(await operatorDelete(a.id, freshId())).toBe(false);
    expect(await operatorDelete(freshId(), ofA)).toBe(false);

    expect([await storedRows(a.id), await storedRows(b.id)]).toEqual([1, 1]);
    expect([await bookmarkCount(a.id), await bookmarkCount(b.id)]).toEqual([1, 1]);
    expect(await eventsOf(a.id)).toEqual([]);
    expect(await eventsOf(b.id)).toEqual([]);
    await assertCounterMatches();
  });

  it("answers false and changes nothing for a workspace that is being deleted", async () => {
    const workspace = await workspaceOf(1);
    const bookmark = await seedBookmark({ workspaceId: workspace.id, ownerId: null });
    await asSystem(db, (tx) => tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${workspace.id}`);

    expect(await operatorDelete(workspace.id, bookmark)).toBe(false);

    expect(await bookmarkExists(bookmark)).toBe(true);
    expect(await bookmarkCount(workspace.id)).toBe(1);
    expect(await eventsOf(workspace.id)).toEqual([]);
  });
});

describe("the arguments", () => {
  it("refuses a NULL argument, writing nothing", async () => {
    const workspace = await workspaceOf(1);
    const bookmark = await seedBookmark({ workspaceId: workspace.id, ownerId: null });

    expect(await failureCode(operatorDelete(null, bookmark))).toBe(INVALID_PARAMETER_VALUE);
    expect(await failureCode(operatorDelete(workspace.id, null))).toBe(INVALID_PARAMETER_VALUE);
    expect(await failureCode(operatorDelete(workspace.id, bookmark, null))).toBe(INVALID_PARAMETER_VALUE);
    expect(await failureCode(operatorDelete(workspace.id, bookmark, REASON, null))).toBe(INVALID_PARAMETER_VALUE);

    expect(await bookmarkExists(bookmark)).toBe(true);
    expect(await eventsOf(workspace.id)).toEqual([]);
  });

  it.each([
    ["an empty reason", ""],
    ["a reason of spaces", "     "],
    ["a reason of 101 characters", "a".repeat(101)],
    ["a reason of 101 code points that are not ASCII", "ä".repeat(101)],
    ["a reason with a tab", "court\torder"],
    ["a reason with a line break", "court\norder"],
    ["a reason with a carriage return", "court\rorder"],
    ["a reason with an escape character", "court\u001border"],
    ["a reason with the delete character", "court\u007forder"],
    ["a reason with a C1 control character", "court\u0085order"],
    ["a reason with a line separator", "court\u2028order"],
  ])("refuses %s, removing nothing and writing no event", async (_name, reason) => {
    const workspace = await workspaceOf(1);
    const bookmark = await seedBookmark({ workspaceId: workspace.id, ownerId: null });

    expect(await failureCode(operatorDelete(workspace.id, bookmark, reason))).toBe(INVALID_PARAMETER_VALUE);

    expect(await bookmarkExists(bookmark)).toBe(true);
    expect(await bookmarkCount(workspace.id)).toBe(1);
    expect(await eventsOf(workspace.id)).toEqual([]);
  });

  it("accepts a reason of 100 characters, keeps its inner spaces and stores it trimmed", async () => {
    const workspace = await workspaceOf(1);
    const first = await seedBookmark({ workspaceId: workspace.id, ownerId: null });
    const second = await seedBookmark({ workspaceId: workspace.id, ownerId: null });
    const longest = `${"ä".repeat(49)} ${"b".repeat(50)}`;
    expect(Array.from(longest)).toHaveLength(100);

    expect(await operatorDelete(workspace.id, first, `  ${longest}   `)).toBe(true);
    expect(await operatorDelete(workspace.id, second, "  Moderation  decision  ")).toBe(true);

    expect((await eventsOf(workspace.id)).map((event) => event.metadata)).toEqual([{ reason: longest }, { reason: "Moderation  decision" }]);
  });

  it("takes the event identifier from the caller and refuses one that is in use, removing nothing", async () => {
    const workspace = await workspaceOf(1);
    const first = await seedBookmark({ workspaceId: workspace.id, ownerId: null });
    const second = await seedBookmark({ workspaceId: workspace.id, ownerId: null });
    const eventId = freshId();
    expect(await operatorDelete(workspace.id, first, REASON, eventId)).toBe(true);

    expect(await failureCode(operatorDelete(workspace.id, second, REASON, eventId))).toBe(UNIQUE_VIOLATION);

    expect(await bookmarkExists(second)).toBe(true);
    expect(await bookmarkCount(workspace.id)).toBe(1);
    expect(await eventsOf(workspace.id)).toHaveLength(1);
    await assertCounterMatches();
  });
});

describe("one transaction", () => {
  it("leaves neither the removal, the counter nor the event when the transaction rolls back after the call", async () => {
    const workspace = await workspaceOf(1);
    const bookmark = await seedBookmark({ workspaceId: workspace.id, ownerId: null });

    const outcome = await failureCode(
      db.owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        const rows = await tx<{ removed: boolean }[]>`SELECT sys_bookmark_operator_delete(${workspace.id}::uuid, ${bookmark}::uuid, ${freshId()}::uuid, ${REASON}) AS removed`;
        expect(rows[0]?.removed).toBe(true);
        await tx`SELECT 1/0`;
      }),
    );

    expect(outcome).toBe("22012");
    expect(await bookmarkExists(bookmark)).toBe(true);
    expect(await bookmarkCount(workspace.id)).toBe(1);
    expect(await eventsOf(workspace.id)).toEqual([]);
    await assertCounterMatches();
  });

  it("takes the workspace's row before the bookmark's, so it waits for a writer of the workspace and does not deadlock with it", async () => {
    const workspace = await workspaceOf(1);
    const bookmark = await seedBookmark({ workspaceId: workspace.id, ownerId: null });
    // Both connections of the owner pool are open before the holder takes one, so that the removal does not wait for the holder's.
    await Promise.all([db.owner`SELECT pg_sleep(0.1)`, db.owner`SELECT pg_sleep(0.1)`]);
    let finished = false;
    let removal: Promise<boolean> = Promise.resolve(false);

    // The holder locks the workspace's row, starts the removal on the other connection of the pool and, as the migration login, which sees its own
    // sessions, waits until one of them waits for the holder's transaction (the only other session of this database that writes) before it commits.
    const waited = await asSystem(db, async (tx) => {
      await tx`SELECT 1 FROM workspaces WHERE id = ${workspace.id} FOR NO KEY UPDATE`;
      removal = operatorDelete(workspace.id, bookmark).then((removed) => {
        finished = true;
        return removed;
      });
      await tx`SET LOCAL ROLE NONE`;
      let blocked = false;
      for (let attempt = 0; attempt < 200 && !blocked; attempt += 1) {
        const rows = await tx<{ n: string }[]>`
          SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'transactionid' AND pid <> pg_backend_pid()`;
        blocked = Number(rows[0]?.n) > 0;
        if (!blocked) {
          await sleep(25);
        }
      }
      const finishedWhileBlocked = finished;
      // A removal of a member holds the workspace's row and then reaches for the bookmark's. The removal blocked here has locked nothing but the wait
      // for the workspace's row, so this write to the bookmark goes through; a removal that had locked the bookmark first would deadlock with it.
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE bookmarks SET title = 'Retitled' WHERE id = ${bookmark}`;
      return { blocked, finishedWhileBlocked };
    });

    expect(waited).toEqual({ blocked: true, finishedWhileBlocked: false });
    expect(await removal).toBe(true);
    expect(await bookmarkExists(bookmark)).toBe(false);
    await assertCounterMatches();
  }, HOOK_TIMEOUT_MS);
});

describe("the grants", () => {
  it("are refused to slugbase_app, also inside the tenant transaction, and to PUBLIC", async () => {
    const workspace = await workspaceOf(1);
    const owner = memberOf(workspace, 0);
    const bookmark = await seedBookmark({ workspaceId: workspace.id, ownerId: null });
    const call = (tx: postgres.TransactionSql) => tx`SELECT sys_bookmark_operator_delete(${workspace.id}::uuid, ${bookmark}::uuid, ${freshId()}::uuid, ${REASON}::text)`;

    expect(await failureCode(db.app.begin((tx) => call(tx)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await failureCode(appAs({ accountId: owner, workspaceId: workspace.id }, call))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await failureCode(
        db.tenant.withTenant({ accountId: owner, workspaceId: workspace.id, requestId: "operator-delete-test" }, (tx) =>
          tenantHandle(tx).execute(sql`SELECT sys_bookmark_operator_delete(${workspace.id}::uuid, ${bookmark}::uuid, ${freshId()}::uuid, ${REASON}::text)`),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);

    const [privileges] = await db.owner<{ app: boolean; public_role: boolean; public_acl: boolean }[]>`
      SELECT has_function_privilege('slugbase_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_role,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_acl
      FROM pg_proc p WHERE p.oid = 'public.sys_bookmark_operator_delete(uuid, uuid, uuid, text)'::regprocedure`;
    expect(privileges).toEqual({ app: false, public_role: false, public_acl: false });
    expect(await bookmarkExists(bookmark)).toBe(true);
    expect(await eventsOf(workspace.id)).toEqual([]);
  });

  it("are not the migration login's until it sets the role slugbase_system", async () => {
    const workspace = await workspaceOf(1);
    const bookmark = await seedBookmark({ workspaceId: workspace.id, ownerId: null });

    const withoutRole = db.owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE NONE`;
      const [login] = await tx<{ session_user: string; current_user: string }[]>`SELECT session_user::text AS session_user, current_user::text AS current_user`;
      expect(login).toEqual({ session_user: "slugbase_migrator", current_user: "slugbase_migrator" });
      await tx`SELECT sys_bookmark_operator_delete(${workspace.id}::uuid, ${bookmark}::uuid, ${freshId()}::uuid, ${REASON}::text)`;
    });
    expect(await failureCode(withoutRole)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await bookmarkExists(bookmark)).toBe(true);

    expect(await operatorDelete(workspace.id, bookmark)).toBe(true);
    expect(await bookmarkExists(bookmark)).toBe(false);
  });

  it("do not let a member of the workspace remove another's bookmark by calling it with a workspace the transaction does not act in", async () => {
    const a = await workspaceOf(1);
    const b = await workspaceOf(1);
    const ofB = await seedBookmark({ workspaceId: b.id, ownerId: memberOf(b, 0) });

    const outcome = await failureCode(
      appAs({ accountId: memberOf(a, 0), workspaceId: a.id }, (tx) => tx`SELECT sys_bookmark_operator_delete(${b.id}::uuid, ${ofB}::uuid, ${freshId()}::uuid, ${REASON}::text)`),
    );

    expect(outcome).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await bookmarkExists(ofB)).toBe(true);
    expect(await bookmarkCount(b.id)).toBe(1);
    expect(await eventsOf(b.id)).toEqual([]);
  });
});
