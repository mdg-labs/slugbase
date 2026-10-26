import type { BookmarkTagName } from "@slugbase/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountDeletionRepository, bookmarkRepository, tagRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
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
