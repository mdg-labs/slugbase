import type { BookmarkTagName } from "@slugbase/core";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountDeletionRepository, bookmarkRepository, memberRepository, tagRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { tenantHandle, type TenantTx } from "../src/tenant.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The order in which a merge of two tags, the tagging of a bookmark, the removal of a member and the deletion of an account lock what they share (doc 05
// section 2.4, doc 02 section 7.2, doc 04 section 10.7): the workspace row, then the bookmarks, then the tags. A merge that held both tags and asked for a
// bookmark that a change holds while that change asks for one of the tags, a creation that held a tag while it waited for a workspace row that the deletion
// of an account holds and that deletion waited for the tag, or a change that held a tag while it waited for a bookmark that the removal of a member holds and
// that removal waited for the tag, would each be one end of a deadlock, and the database would abort one request with an error. The failure scenarios: an
// owner changes the tags of a bookmark (by identifier, or by a name and an identifier) at the moment the owner merges two of those tags, a bookmark that
// carries the source is deleted while the merge copies its links, a tag a change names by identifier is merged away first, a bookmark gains the source
// while a merge waits for the tags (the merge copies its link, and the bookmark stays the merge's until it ends; and the merge reads the links again under
// the tag locks, so that a change of that bookmark which names the target does not end in a deadlock), a creation names an existing tag while its account
// is deleted, and a change names tags while the member who owns them is removed; every request ends in its own answer and none in a server error.
//
// Each test holds one of the requests at a lock it takes after the one the other request waits on, until the requests wait for a lock, so the interleaving
// does not depend on timing. Of these tests, the one of a tagging that commits while a merge and a change of the same bookmark wait is the one that needs
// the merge to read the links again under the tag locks: without that read the database aborts one of the two with a deadlock (40P01). That test holds
// every step by a lock and reads `pg_blocking_pids` at each, so it fails at the step that moved, and not with a deadlock, if the interleaving shifts: the
// merge waits at the source for the tagging, which holds it `FOR KEY SHARE`; a second holder takes the same lock; the change waits at the bookmark for the
// tagging (whose link holds the bookmark `FOR KEY SHARE`) and has locked nothing; when the tagging commits the change takes the bookmark and waits at the
// target for the merge, and the merge waits at the source for the second holder; and only then does the second holder end.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;

interface Scene {
  readonly workspaceId: string;
  readonly owner: string;
}

async function scene(): Promise<Scene> {
  emailNumber += 1;
  const owner = freshId();
  await seedAccount(db, { id: owner, email: `tag-merge-order${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  const workspaceId = await seedWorkspace(db, { name: "Tag merge lock order" });
  await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
  return { workspaceId, owner };
}

function inTenant<T>(of: Scene, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId: of.owner, workspaceId: of.workspaceId, requestId: "tag-merge-order" }, work);
}

async function seedTag(of: Scene, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${id}, ${of.workspaceId}, ${of.owner}, ${name})`);
  return id;
}

/** Two tags of the owner, the first with the lower identifier, whatever order they were made in. */
async function twoTags(of: Scene, names: readonly [string, string]): Promise<{ low: string; high: string; lowName: string; highName: string }> {
  const first = await seedTag(of, names[0]);
  const second = await seedTag(of, names[1]);
  return first < second ? { low: first, high: second, lowName: names[0], highName: names[1] } : { low: second, high: first, lowName: names[1], highName: names[0] };
}

async function seedBookmark(of: Scene): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
      VALUES (${id}, ${of.workspaceId}, ${of.owner}, 'https://example.com/seed', 'https://example.com/seed', 'example.com', 'Seed')`,
  );
  return id;
}

async function link(of: Scene, bookmarkId: string, tagId: string): Promise<void> {
  await asSystem(db, (tx) => tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${of.workspaceId}, ${bookmarkId}, ${tagId})`);
}

async function linksByTag(of: Scene): Promise<Record<string, number>> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ name: string; n: string }[]>`
      SELECT t.name::text AS name, count(l.bookmark_id)::text AS n FROM tags t LEFT JOIN bookmark_tags l ON l.tag_id = t.id WHERE t.workspace_id = ${of.workspaceId} GROUP BY t.name ORDER BY t.name`,
  );
  return Object.fromEntries(rows.map((row) => [row.name, Number(row.n)]));
}

/** How many backends of this database wait for a lock. The probes run on the application pool: the owner pool has two connections, and the holders may hold both. */
async function backendsWaitingForLock(): Promise<number> {
  const rows = await db.app<{ waiting: string }[]>`
    SELECT count(DISTINCT l.pid)::text AS waiting
    FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE NOT l.granted AND s.datname = current_database()`;
  return Number(rows[0]?.waiting ?? 0);
}

async function waitUntilWaiting(backends: number, what: string): Promise<void> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  while ((await backendsWaitingForLock()) < backends) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never waited for a lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The value of `work`, or `error:<SQLSTATE>` (or `error:<message>`) when it fails, so a test can name what a loser of a deadlock gets. */
async function settle<T>(work: Promise<T>): Promise<T | string> {
  try {
    return await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string") {
        return `error:${code}`;
      }
      current = cause;
    }
    return `error:${error instanceof Error ? error.message : "unknown"}`;
  }
}

function gate(): { readonly open: () => void; readonly opened: Promise<void> } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** A transaction as slugbase_system that holds the locks `work` takes until `release` is called, and answers once it holds them (`pid` is its backend). */
async function holder(work: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<{ readonly pid: number; readonly release: () => void; readonly done: Promise<void> }> {
  const held = gate();
  const release = gate();
  let pid = 0;
  const done = asSystem(db, async (tx) => {
    pid = (await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid ?? 0;
    await work(tx);
    held.open();
    await release.opened;
  }).then(() => undefined);
  await Promise.race([held.opened, done]);
  return { pid, release: release.open, done };
}

/** The backends of this database that wait for a lock, in the order of their pids. */
async function waitingPids(): Promise<number[]> {
  const rows = await db.app<{ pid: number }[]>`
    SELECT DISTINCT l.pid FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE NOT l.granted AND s.datname = current_database() ORDER BY l.pid`;
  return rows.map((row) => row.pid);
}

/** The backends that `pid` waits for (`pg_blocking_pids`), in the order of their pids. */
async function blockers(pid: number): Promise<number[]> {
  const rows = await db.app<{ pids: number[] }[]>`SELECT pg_blocking_pids(${pid}) AS pids`;
  return [...(rows[0]?.pids ?? [])].sort((a, b) => a - b);
}

/** Waits until the blockers of `pid` are exactly `expected`, and fails with the blockers it last saw when they never are. */
async function waitUntilBlockedBy(pid: number, expected: readonly number[], what: string): Promise<void> {
  const wanted = [...expected].sort((a, b) => a - b);
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  let seen = await blockers(pid);
  while (seen.join() !== wanted.join()) {
    if (Date.now() > deadline) {
      throw new Error(`${what}: backend ${String(pid)} is blocked by [${seen.join(", ")}], and not by [${wanted.join(", ")}]`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    seen = await blockers(pid);
  }
}

const merge = (of: Scene, sourceId: string, targetId: string) => inTenant(of, (tx) => tagRepository(tx).merge({ sourceId, targetId, ownerId: of.owner })).then((outcome) => outcome.kind);

function named(...names: string[]): BookmarkTagName[] {
  return names.map((name) => ({ name, newId: freshId() }));
}

describe("a change of the tags of a bookmark against a merge of two of them", () => {
  it("queues the two when the change names the source and the target by identifier and the bookmark carries the source", async () => {
    const of = await scene();
    const { low: source, high: target } = await twoTags(of, ["Source", "Target"]);
    const bookmark = await seedBookmark(of);
    await link(of, bookmark, source);
    const folder = freshId();
    await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${folder}, ${of.workspaceId}, ${of.owner}, 'Held')`);
    // The change files the bookmark into a folder, which it locks after the bookmark; this holder keeps it from getting that lock until the merge waits.
    const held = await holder((tx) => tx`SELECT id FROM folders WHERE id = ${folder} FOR UPDATE`);

    const changed = settle(
      inTenant(of, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark, ownerId: of.owner, expectedVersions: undefined, changes: { folderIds: [folder], tags: { ids: [source, target], names: [] } } })).then(
        (result) => result.kind,
      ),
    );
    await waitUntilWaiting(1, "the change");
    const merged = settle(merge(of, source, target));
    await waitUntilWaiting(2, "the merge");
    held.release();

    expect([await changed, await merged]).toEqual(["updated", "merged"]);
    await held.done;
    expect(await linksByTag(of)).toEqual({ Target: 1 });
  }, TEST_TIMEOUT_MS);

  it("queues the two when the change names one tag by name and another by identifier, whichever of the two has the lower identifier", async () => {
    const of = await scene();
    const { low, high, lowName, highName } = await twoTags(of, ["Alpha", "Omega"]);
    const bookmark = await seedBookmark(of);
    await link(of, bookmark, low);
    // The change creates a third tag by name, and waits at it for a transaction that has made the same name and not yet ended: it has locked the tags it names
    // that exist by then, and none of them is the one it waits for.
    const concurrent = freshId();
    const held = await holder((tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${concurrent}, ${of.workspaceId}, ${of.owner}, 'Concurrent')`);

    const changed = settle(
      inTenant(of, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark, ownerId: of.owner, expectedVersions: undefined, changes: { tags: { ids: [low], names: [...named(highName, "Concurrent")] } } })).then(
        (result) => result.kind,
      ),
    );
    await waitUntilWaiting(1, "the change");
    const merged = settle(merge(of, high, low));
    await waitUntilWaiting(2, "the merge");
    held.release();

    expect([await changed, await merged]).toEqual(["updated", "merged"]);
    await held.done;
    expect(await linksByTag(of)).toEqual({ [lowName]: 1, Concurrent: 1 });
  }, TEST_TIMEOUT_MS);

  it("answers tag_not_found, and not an error, for a tag named by identifier that a merge deletes before the change locks it", async () => {
    const of = await scene();
    const { low: source, high: target } = await twoTags(of, ["Source", "Target"]);
    const bookmark = await seedBookmark(of);
    await link(of, await seedBookmark(of), source);
    const reached = gate();
    const finish = gate();
    const merging = settle(
      inTenant(of, async (tx) => {
        const outcome = await tagRepository(tx).merge({ sourceId: source, targetId: target, ownerId: of.owner });
        reached.open();
        await finish.opened;
        return outcome.kind;
      }),
    );
    await reached.opened;

    const changed = settle(
      inTenant(of, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark, ownerId: of.owner, expectedVersions: undefined, changes: { tags: { ids: [source], names: [] } } })).then((result) => result.kind),
    );
    await waitUntilWaiting(1, "the change");
    finish.open();

    expect(await merging).toBe("merged");
    expect(await changed).toBe("tag_not_found");
    expect(await linksByTag(of)).toEqual({ Target: 1 });
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM bookmark_tags WHERE bookmark_id = ${bookmark}`)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});

describe("a merge against the deletion of a bookmark that carries the source", () => {
  it("leaves out the bookmark that is deleted while the links are copied, and copies the others", async () => {
    const of = await scene();
    const { low: source, high: target } = await twoTags(of, ["Source", "Target"]);
    const [kept, deleted] = [await seedBookmark(of), await seedBookmark(of)];
    await link(of, kept, source);
    await link(of, deleted, source);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = 2 WHERE id = ${of.workspaceId}`);
    const reached = gate();
    const commit = gate();
    const deleting = settle(
      inTenant(of, async (tx) => {
        const removed = await bookmarkRepository(tx).remove({ bookmarkId: deleted, ownerId: of.owner });
        reached.open();
        await commit.opened;
        return removed;
      }),
    );
    await reached.opened;

    const merged = settle(merge(of, source, target));
    await waitUntilWaiting(1, "the merge");
    commit.open();

    expect(await deleting).toBe(true);
    expect(await merged).toBe("merged");
    expect(await linksByTag(of)).toEqual({ Target: 1 });
  }, TEST_TIMEOUT_MS);
});

describe("a merge against a tagging that commits between the merge's reading of the bookmarks and its locking of the tags", () => {
  it("copies the link the tagging added, and a deletion of that bookmark waits for the merge to end", async () => {
    const of = await scene();
    const { low: source, high: target } = await twoTags(of, ["Source", "Target"]);
    const bookmark = await seedBookmark(of);
    await asSystem(db, (tx) => tx`UPDATE workspaces SET bookmark_count = 1 WHERE id = ${of.workspaceId}`);
    // A tagging as another transaction does it: it holds the source `FOR KEY SHARE` and adds its link, and commits when it is released.
    const held = await holder(async (tx) => {
      await tx`SELECT id FROM tags WHERE id = ${source} FOR KEY SHARE`;
      await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${of.workspaceId}, ${bookmark}, ${source})`;
    });
    const reached = gate();
    const finish = gate();
    const merging = settle(
      inTenant(of, async (tx) => {
        const outcome = await tagRepository(tx).merge({ sourceId: source, targetId: target, ownerId: of.owner });
        reached.open();
        await finish.opened;
        return outcome.kind;
      }),
    );
    await waitUntilWaiting(1, "the merge");
    held.release();
    await reached.opened;

    // The merge has copied the link of the bookmark and not ended: the bookmark is locked by the merge until it does.
    const deleting = settle(inTenant(of, (tx) => bookmarkRepository(tx).remove({ bookmarkId: bookmark, ownerId: of.owner })));
    await waitUntilWaiting(1, "the deletion");
    finish.open();

    expect([await merging, await deleting]).toEqual(["merged", true]);
    await held.done;
    expect(await linksByTag(of)).toEqual({ Target: 0 });
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM tags WHERE id = ${source}`)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it("ends both a merge into a lower tag and a change of the tagged bookmark that names that tag in their own answers, when the tagging commits while both wait", async () => {
    const of = await scene();
    const { low: target, high: source } = await twoTags(of, ["Target", "Source"]);
    const bookmark = await seedBookmark(of);
    // A tagging as another transaction does it: it holds the source `FOR KEY SHARE` and adds its link, which holds the bookmark `FOR KEY SHARE` through the
    // foreign key of the link. It commits when it is released.
    const tagging = await holder(async (tx) => {
      await tx`SELECT id FROM tags WHERE id = ${source} FOR KEY SHARE`;
      await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${of.workspaceId}, ${bookmark}, ${source})`;
    });
    const holders = [tagging];
    try {
      // The merge cannot see the uncommitted link, so it locks no bookmark; it locks the target, which has the lower identifier, and waits at the source for
      // the tagging.
      const merged = settle(merge(of, source, target));
      await waitUntilWaiting(1, "the merge");
      const [mergePid = 0, ...others] = await waitingPids();
      expect(others).toEqual([]);
      await waitUntilBlockedBy(mergePid, [tagging.pid], "the merge waits at the source for the tagging");
      // A second holder of the source `FOR KEY SHARE` (a second tagging that has not ended), which the merge will wait for once the tagging commits. It takes
      // the lock beside the tagging's, and the merge, which is waiting for the tagging, keeps waiting for it.
      const other = await holder((tx) => tx`SELECT id FROM tags WHERE id = ${source} FOR KEY SHARE`);
      holders.push(other);
      await waitUntilBlockedBy(mergePid, [tagging.pid], "the merge still waits at the source for the tagging");
      // The change takes the bookmark `FOR UPDATE`, which the link of the tagging holds `FOR KEY SHARE` through its foreign key: it waits at the bookmark for the
      // tagging, and has locked nothing yet.
      const changed = settle(
        inTenant(of, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark, ownerId: of.owner, expectedVersions: undefined, changes: { tags: { ids: [target], names: [] } } })).then(
          (result) => result.kind,
        ),
      );
      await waitUntilWaiting(2, "the change");
      const changePid = (await waitingPids()).find((pid) => pid !== mergePid) ?? 0;
      await waitUntilBlockedBy(changePid, [tagging.pid], "the change waits at the bookmark for the tagging");
      // The tagging commits. The change takes the bookmark and then waits at the target, which the merge holds; the merge, which wakes with it, finds the
      // second holder on the source and waits for that. Neither of the two can go on until the second holder ends, and the change waits for the merge.
      tagging.release();
      await tagging.done;
      await waitUntilBlockedBy(changePid, [mergePid], "the change waits at the target for the merge");
      await waitUntilBlockedBy(mergePid, [other.pid], "the merge waits at the source for the second holder");
      // Only now does the merge get the source. Without the second read of the links under the tag locks it would copy the link of the bookmark that the change
      // holds, wait for the change, and the change would wait for the merge (40P01).
      other.release();

      expect([await merged, await changed]).toEqual(["merged", "updated"]);
    } finally {
      // A failed step leaves no holder behind for the tests after it.
      for (const held of holders) {
        held.release();
      }
    }
    await Promise.all(holders.map((held) => held.done));
    expect(await linksByTag(of)).toEqual({ Target: 1 });
    expect(await asSystem(db, (tx) => tx`SELECT 1 FROM tags WHERE id = ${source}`)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});

describe("a creation of a bookmark against the deletion of its account", () => {
  it("is answered, and not aborted, when it names an existing tag while the deletion holds the workspace and waits to delete the account", async () => {
    const of = await scene();
    const tag = await seedTag(of, "Existing");
    const reached = gate();
    const proceed = gate();
    // The deletion of an account locks the account's workspaces first (its scope), runs its guards, and then deletes the account, whose tags go with it.
    const deleting = settle(
      db.tenant.withTenant({ accountId: of.owner, requestId: "tag-merge-order" }, async (tx) => {
        const repository = accountDeletionRepository(tx);
        const scope = await repository.scope();
        reached.open();
        await proceed.opened;
        return repository.delete(scope.soleMember.map((workspace) => workspace.id), []);
      }),
    );
    await reached.opened;

    const bookmark = { id: freshId(), ownerId: of.owner, url: "https://example.com/new", urlCanonical: "https://example.com/new", host: "example.com", title: "New", description: null, pinned: false };
    const created = settle(inTenant(of, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [], tags: { ids: [tag], names: [] } })).then((result) => result.kind));
    await waitUntilWaiting(1, "the creation");
    proceed.open();

    expect([await deleting, await created]).toEqual([true, "unavailable"]);
  }, TEST_TIMEOUT_MS);
});

describe("a change of the tags of a bookmark against the removal of the member who owns it", () => {
  it("ends in its own answer when the removal holds the bookmark while the change holds a tag and waits for another", async () => {
    const of = await scene();
    const member = freshId();
    await seedAccount(db, { id: member, email: `tag-merge-order-member${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
    await seedMember(db, { workspaceId: of.workspaceId, accountId: member, role: "member" });
    const as = { workspaceId: of.workspaceId, owner: member };
    const { low, high } = await twoTags(as, ["Alpha", "Omega"]);
    const third = await seedTag(as, "Third");
    const bookmark = await seedBookmark(as);
    // A merge into the higher tag holds it `FOR UPDATE`, so the change locks the lower tag and waits for the higher; the removal arrives while it does.
    const reached = gate();
    const finish = gate();
    const holding = settle(
      inTenant(as, async (tx) => {
        const outcome = await tagRepository(tx).merge({ sourceId: third, targetId: high, ownerId: member });
        reached.open();
        await finish.opened;
        return outcome.kind;
      }),
    );
    await reached.opened;

    const changed = settle(
      inTenant(as, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark, ownerId: member, expectedVersions: undefined, changes: { tags: { ids: [low, high], names: [] } } })).then((result) => result.kind),
    );
    await waitUntilWaiting(1, "the change");
    // The removal of a member clears the owner of the member's bookmarks, then deletes the member's tags (the foreign keys of both to workspace_members).
    const removed = settle(asSystem(db, async (tx) => (await tx`DELETE FROM workspace_members WHERE workspace_id = ${of.workspaceId} AND account_id = ${member}`).count > 0));
    await waitUntilWaiting(2, "the removal");
    finish.open();

    expect([await holding, await changed, await removed]).toEqual(["merged", "updated", true]);
  }, TEST_TIMEOUT_MS);
});

// The departure of a member and the creation of a tag by name (doc 05 section 2.4, issue 582). A change that names a tag its owner has none of inserts it, and
// the insert takes the owner's membership row and the workspace row through foreign keys (`FOR KEY SHARE`). Every departure takes the workspace row and then the
// membership row before it reaches the member's bookmarks, so a change that took the two only at its insert, after its bookmark, would wait for a departure that
// waits for the bookmark. Where a test needs the change held at the insert of its new tag, an uncommitted tag of that name, which another transaction ends by
// rolling back, holds it there. The waits are attributed with `pg_blocking_pids` (`waitingBlockedBy`), except the removal's in the first test, which is counted
// (`waitUntilWaiting`) because the membership row it waits for is held by the uncommitted tag and by the change. The account-deletion test holds the deletion
// first, with no uncommitted tag, and the creation test runs a creation, not a change, against the removal.

class RolledBack extends Error {}

/** A transaction as slugbase_system that inserts the tag `name` of `ownerId` and keeps it uncommitted until `release` is called, which rolls it back, so that an insert of that name waits for it and then goes on. */
async function uncommittedTag(of: Scene, ownerId: string, name: string): Promise<{ readonly pid: number; readonly release: () => void; readonly done: Promise<unknown> }> {
  const held = gate();
  const release = gate();
  let pid = 0;
  const done = settle(
    asSystem(db, async (tx) => {
      pid = (await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid ?? 0;
      await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${freshId()}, ${of.workspaceId}, ${ownerId}, ${name})`;
      held.open();
      await release.opened;
      throw new RolledBack();
    }),
  );
  await Promise.race([held.opened, done]);
  return { pid, release: release.open, done };
}

async function backendPid(tx: TenantTx): Promise<number> {
  return (await tenantHandle(tx).execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]?.pid ?? 0;
}

/** The scene's owner and a member with a bookmark and a tag "Kept" of their own. */
async function memberScene(): Promise<{ of: Scene; member: string; as: Scene; bookmark: string; kept: string }> {
  const of = await scene();
  const member = freshId();
  await seedAccount(db, { id: member, email: `tag-departure-member${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  await seedMember(db, { workspaceId: of.workspaceId, accountId: member, role: "member" });
  const as = { workspaceId: of.workspaceId, owner: member };
  return { of, member, as, bookmark: await seedBookmark(as), kept: await seedTag(as, "Kept") };
}

/** The workspace's owner removes `member`, the way a removal does: the roles are read (the workspace row is locked), then the membership is deleted, and `afterwards` may hold the transaction open. */
function removing(of: Scene, member: string, afterwards: (pid: number) => Promise<void> = () => Promise.resolve()): Promise<boolean | string> {
  return settle(
    inTenant(of, async (tx) => {
      const members = memberRepository(tx);
      await members.roles(member);
      const removed = await members.remove(member, []);
      await afterwards(await backendPid(tx));
      return removed;
    }),
  );
}

function changing(as: Scene, bookmark: string, tags: { ids: string[]; names: BookmarkTagName[] }): Promise<string> {
  return settle(inTenant(as, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark, ownerId: as.owner, expectedVersions: undefined, changes: { tags } })).then((result) => result.kind));
}

async function storedOf(as: Scene): Promise<{ tags: string[]; links: number; owners: (string | null)[] }> {
  return asSystem(db, async (tx) => ({
    tags: (await tx<{ name: string }[]>`SELECT name::text AS name FROM tags WHERE workspace_id = ${as.workspaceId} ORDER BY name`).map((row) => row.name),
    links: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmark_tags WHERE workspace_id = ${as.workspaceId}`)[0]?.n ?? -1,
    owners: (await tx<{ owner_id: string | null }[]>`SELECT owner_id FROM bookmarks WHERE workspace_id = ${as.workspaceId} ORDER BY id`).map((row) => row.owner_id),
  }));
}

/** Waits until a backend is blocked by exactly `expected` (`pg_blocking_pids`) and answers its pid; fails with what every waiting backend is blocked by when none ever is. */
async function waitingBlockedBy(expected: readonly number[], what: string): Promise<number> {
  const wanted = [...expected].sort((a, b) => a - b).join();
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  for (;;) {
    const seen: string[] = [];
    for (const waiting of await waitingPids()) {
      const by = (await blockers(waiting)).join();
      if (by === wanted) {
        return waiting;
      }
      seen.push(`${String(waiting)} by [${by}]`);
    }
    if (Date.now() > deadline) {
      throw new Error(`${what}: no backend is blocked by [${wanted}]; waiting: ${seen.join("; ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Runs `work` while `pending` holds its uncommitted tag, and rolls the tag back when `work` ends, whichever way. */
async function whileUncommitted<T>(pending: { readonly release: () => void; readonly done: Promise<unknown> }, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    pending.release();
    await pending.done;
  }
}

describe("a change that creates a tag by name against the departure of its owner", () => {
  // The uncommitted tag's insert holds the membership row and the workspace row `FOR KEY SHARE` through its foreign keys, so a departure waits for it as well.
  it("queues the removal behind the change, which commits its new tag, and then removes the member", async () => {
    const { of, member, as, bookmark, kept } = await memberScene();
    const pending = await uncommittedTag(as, member, "Fresh");
    const [changed, removed] = await whileUncommitted(pending, async () => {
      const change = changing(as, bookmark, { ids: [kept], names: named("Fresh") });
      // The change waits at the insert of "Fresh" for the uncommitted tag, holding its bookmark and "Kept".
      await waitingBlockedBy([pending.pid], "the change waits at the new tag for the uncommitted one");
      const removal = removing(of, member);
      // The removal waits for the membership row, which the uncommitted tag and the change both hold `FOR KEY SHARE`; the database names the first of the holders it waits for.
      await waitUntilWaiting(2, "the removal");
      return [change, removal] as const;
    });

    expect([await changed, await removed]).toEqual(["updated", true]);
    expect(await storedOf(as)).toEqual({ tags: [], links: 0, owners: [null] });
  }, TEST_TIMEOUT_MS);

  it("waits for a removal that holds the membership, and answers not_found, writing no tag and no link, when the removal commits", async () => {
    const { of, member, as, bookmark, kept } = await memberScene();
    const reached = gate();
    const finish = gate();
    let removalPid = 0;
    const removed = removing(of, member, async (pid) => {
      removalPid = pid;
      reached.open();
      await finish.opened;
    });
    await Promise.race([reached.opened, removed]);
    let changed: Promise<string> | undefined;
    try {
      changed = changing(as, bookmark, { ids: [kept], names: named("Fresh") });
      await waitingBlockedBy([removalPid], "the change waits for the removal");
    } finally {
      finish.open();
    }

    expect([await removed, await changed]).toEqual([true, "not_found"]);
    expect(await storedOf(as)).toEqual({ tags: [], links: 0, owners: [null] });
  }, TEST_TIMEOUT_MS);

  it("waits for the deletion of the owner's account, which holds the workspace, and answers not_found when the account is gone", async () => {
    const { member, as, bookmark, kept } = await memberScene();
    const reached = gate();
    const proceed = gate();
    let deletionPid = 0;
    // The deletion of an account locks the account's workspaces first (its scope), runs its guards, and then deletes the account, whose membership, bookmarks and tags go with it.
    const deleting = settle(
      db.tenant.withTenant({ accountId: member, requestId: "tag-merge-order" }, async (tx) => {
        const repository = accountDeletionRepository(tx);
        const scope = await repository.scope();
        deletionPid = await backendPid(tx);
        reached.open();
        await proceed.opened;
        return repository.delete(scope.soleMember.map((workspace) => workspace.id), []);
      }),
    );
    await Promise.race([reached.opened, deleting]);
    let changed: Promise<string> | undefined;
    try {
      changed = changing(as, bookmark, { ids: [kept], names: named("Fresh") });
      await waitingBlockedBy([deletionPid], "the change waits for the deletion");
    } finally {
      proceed.open();
    }

    expect([await deleting, await changed]).toEqual([true, "not_found"]);
    expect(await storedOf(as)).toEqual({ tags: [], links: 0, owners: [null] });
  }, TEST_TIMEOUT_MS);

  it("ends a creation that names a new tag and the removal of its owner in their own answers", async () => {
    const { of, member, as } = await memberScene();
    const pending = await uncommittedTag(as, member, "Fresh");
    const bookmark = { id: freshId(), ownerId: member, url: "https://example.com/new", urlCanonical: "https://example.com/new", host: "example.com", title: "New", description: null, pinned: false };
    const [created, removed] = await whileUncommitted(pending, async () => {
      // A creation locks the workspace row before its bookmark and its tags, so a removal, which locks it first too, queues behind it.
      const creation = settle(inTenant(as, (tx) => bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [], tags: { ids: [], names: named("Fresh") } })).then((result) => result.kind));
      const createPid = await waitingBlockedBy([pending.pid], "the creation waits at the new tag for the uncommitted one");
      const removal = removing(of, member);
      await waitingBlockedBy([createPid], "the removal waits for the creation");
      return [creation, removal] as const;
    });

    expect([await created, await removed]).toEqual(["created", true]);
    expect(await storedOf(as)).toEqual({ tags: [], links: 0, owners: [null, null] });
  }, TEST_TIMEOUT_MS);
});

describe("the tags a change creates by name", () => {
  it("are inserted in the order of their lower-cased names, so a change cannot hold a later name while it waits for an earlier one", async () => {
    const { member, as, bookmark } = await memberScene();
    // Another transaction has "Alpha" uncommitted; the change names "Beta" first and "Alpha" second.
    const pending = await uncommittedTag(as, member, "Alpha");
    const [changed, third] = await whileUncommitted(pending, async () => {
      const change = changing(as, bookmark, { ids: [], names: named("Beta", "Alpha") });
      await waitingBlockedBy([pending.pid], "the change waits at Alpha for the uncommitted tag");
      // A third transaction creates "Beta": the change must not hold it, so this commits without waiting. The wait is bounded, and a "Beta" the change holds ends it in 55P03.
      const inserted = await settle(
        asSystem(db, async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          return (await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${freshId()}, ${as.workspaceId}, ${member}, 'Beta') ON CONFLICT DO NOTHING RETURNING id`).count;
        }),
      );
      return [change, inserted] as const;
    });

    expect(third).toBe(1);
    expect(await changed).toBe("updated");
    expect((await storedOf(as)).tags).toEqual(["Alpha", "Beta", "Kept"]);
  }, TEST_TIMEOUT_MS);
});
