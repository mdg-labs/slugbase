import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// A folder that a bookmark is filed in by `folderIds` and that a concurrent request deletes before the call has locked it (doc 05 section 2.4, doc 02 section
// 7.1). The creation of a bookmark reads the folders it names without a lock, before it takes its place under the ceiling, and locks them after the workspace's
// row and the new bookmark. The failure scenario: a folder the creation names is deleted and the deletion commits while the creation waits, and the creation
// ends in an error (a server error over HTTP) instead of the `folder_not_found` that the same creation gets when the folder was gone before it started. The
// change of a bookmark locks its folders after the bookmark and before its first write, so it finds the folder gone and answers `folder_not_found`. Every
// refusal leaves nothing behind: no bookmark, no place under the ceiling and no link.
//
// Each test holds the request at a lock, asserts with `pg_blocking_pids` who it waits for at each step, and deletes the folder only then, so the interleaving
// does not depend on timing.

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
  await seedAccount(db, { id: owner, email: `folder-lost${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  const workspaceId = await seedWorkspace(db, { name: "Folder lost during creation" });
  await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
  return { workspaceId, owner };
}

function inTenant<T>(of: Scene, work: Parameters<typeof db.tenant.withTenant<T>>[1], requestId = "folder-lost"): Promise<T> {
  return db.tenant.withTenant({ accountId: of.owner, workspaceId: of.workspaceId, requestId }, work);
}

async function seedFolder(of: Scene, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${id}, ${of.workspaceId}, ${of.owner}, ${name})`);
  return id;
}

async function deleteFolder(folderId: string): Promise<void> {
  await asSystem(db, (tx) => tx`DELETE FROM folders WHERE id = ${folderId}`);
}

async function seedBookmark(of: Scene, title = "Seed"): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title)
      VALUES (${id}, ${of.workspaceId}, ${of.owner}, 'https://example.com/seed', 'https://example.com/seed', 'example.com', ${title})`,
  );
  return id;
}

function newBookmark(of: Scene) {
  return { id: freshId(), ownerId: of.owner, url: "https://example.com/new", urlCanonical: "https://example.com/new", host: "example.com", title: "New", description: null, pinned: false };
}

/** What a refused creation or change must not leave: the bookmarks, the count of the workspace, the links to folders, and the names of the folders. */
async function stored(of: Scene): Promise<{ bookmarks: number; count: number; links: number; folders: string[] }> {
  return asSystem(db, async (tx) => {
    const [bookmarks] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks WHERE workspace_id = ${of.workspaceId}`;
    const [workspace] = await tx<{ n: number }[]>`SELECT bookmark_count AS n FROM workspaces WHERE id = ${of.workspaceId}`;
    const [links] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM folder_bookmarks WHERE workspace_id = ${of.workspaceId}`;
    const folders = await tx<{ name: string }[]>`SELECT name::text AS name FROM folders WHERE workspace_id = ${of.workspaceId} ORDER BY name`;
    return { bookmarks: bookmarks?.n ?? -1, count: workspace?.n ?? -1, links: links?.n ?? -1, folders: folders.map((folder) => folder.name) };
  });
}

/** The value of `work`, or `error:<SQLSTATE>` (or `error:<message>`) when it fails, so a test names what the request got instead of its answer. */
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

/** The backends of this database that wait for a lock, in the order of their pids. The probes run on the application pool: the owner pool has two connections, and the holders may hold both. */
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

/** Waits until exactly one backend waits for a lock and answers its pid. */
async function waitUntilOneWaits(what: string): Promise<number> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  let waiting = await waitingPids();
  while (waiting.length < 1) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never waited for a lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    waiting = await waitingPids();
  }
  expect(waiting, `${what}: only one backend should wait`).toHaveLength(1);
  return waiting[0] ?? 0;
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

/** Holds the row of the workspace `FOR NO KEY UPDATE`, which the place under the ceiling of a creation waits for. */
function holdWorkspace(of: Scene) {
  return holder((tx) => tx`SELECT id FROM workspaces WHERE id = ${of.workspaceId} FOR NO KEY UPDATE`);
}

describe("a creation of a bookmark whose folder is deleted while it waits", () => {
  it("answers folder_not_found for a folder deleted while the creation waits for the workspace, and writes nothing", async () => {
    const of = await scene();
    const kept = await seedFolder(of, "Kept");
    const lost = await seedFolder(of, "Lost");
    const held = await holdWorkspace(of);
    try {
      // The creation read both folders and now waits for the place under the ceiling, at the row of the workspace that the holder has.
      const created = settle(inTenant(of, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(of), ceiling: 5, jobs: [], folderIds: [kept, lost] })));
      const creating = await waitUntilOneWaits("the creation");
      await waitUntilBlockedBy(creating, [held.pid], "the creation waits at the workspace for the holder");
      await deleteFolder(lost);
      held.release();

      expect(await created).toEqual({ kind: "folder_not_found" });
    } finally {
      held.release();
    }
    await held.done;
    expect(await stored(of)).toEqual({ bookmarks: 0, count: 0, links: 0, folders: ["Kept"] });
  }, TEST_TIMEOUT_MS);

  it("answers folder_not_found for a folder whose deletion has not ended when the creation locks it, and the place is given back", async () => {
    const of = await scene();
    const lost = await seedFolder(of, "Lost");
    // A deletion of the folder that has not ended makes the creation wait at the folder, after it has read the folder, taken its place and inserted its bookmark.
    const deleting = await holder((tx) => tx`DELETE FROM folders WHERE id = ${lost}`);
    try {
      const created = settle(inTenant(of, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(of), ceiling: 5, jobs: [], folderIds: [lost] })));
      const creating = await waitUntilOneWaits("the creation");
      await waitUntilBlockedBy(creating, [deleting.pid], "the creation waits at the folder for the deletion");
      deleting.release();

      expect(await created).toEqual({ kind: "folder_not_found" });
    } finally {
      deleting.release();
    }
    await deleting.done;
    expect(await stored(of)).toEqual({ bookmarks: 0, count: 0, links: 0, folders: [] });
  }, TEST_TIMEOUT_MS);

  it("answers the creation of a folder that was never there the same way", async () => {
    const of = await scene();
    const created = await inTenant(of, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(of), ceiling: 5, jobs: [], folderIds: [freshId()] }));

    expect(created).toEqual({ kind: "folder_not_found" });
  }, TEST_TIMEOUT_MS);
});

describe("a change of the folders of a bookmark whose folder is deleted while it waits for the bookmark", () => {
  it("answers folder_not_found, and changes nothing", async () => {
    const of = await scene();
    const kept = await seedFolder(of, "Kept");
    const lost = await seedFolder(of, "Lost");
    const bookmark = await seedBookmark(of);
    const held = await holder((tx) => tx`SELECT id FROM bookmarks WHERE id = ${bookmark} FOR UPDATE`);
    try {
      const changed = settle(
        inTenant(of, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark, ownerId: of.owner, expectedVersions: undefined, changes: { title: "Changed", folderIds: [kept, lost] } })),
      );
      const changing = await waitUntilOneWaits("the change");
      await waitUntilBlockedBy(changing, [held.pid], "the change waits at the bookmark for the holder");
      await deleteFolder(lost);
      held.release();

      expect(await changed).toEqual({ kind: "folder_not_found" });
    } finally {
      held.release();
    }
    await held.done;
    expect(await stored(of)).toEqual({ bookmarks: 1, count: 0, links: 0, folders: ["Kept"] });
    expect(await asSystem(db, (tx) => tx<{ title: string; version: number }[]>`SELECT title, version FROM bookmarks WHERE id = ${bookmark}`)).toEqual([{ title: "Seed", version: 1 }]);
  }, TEST_TIMEOUT_MS);

  it("answers folder_not_found for a folder whose deletion has not ended when the change locks it, and changes nothing", async () => {
    const of = await scene();
    const lost = await seedFolder(of, "Lost");
    const bookmark = await seedBookmark(of);
    const deleting = await holder((tx) => tx`DELETE FROM folders WHERE id = ${lost}`);
    try {
      const changed = settle(
        inTenant(of, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark, ownerId: of.owner, expectedVersions: undefined, changes: { title: "Changed", folderIds: [lost] } })),
      );
      const changing = await waitUntilOneWaits("the change");
      await waitUntilBlockedBy(changing, [deleting.pid], "the change waits at the folder for the deletion");
      deleting.release();

      expect(await changed).toEqual({ kind: "folder_not_found" });
    } finally {
      deleting.release();
    }
    await deleting.done;
    expect(await stored(of)).toEqual({ bookmarks: 1, count: 0, links: 0, folders: [] });
    expect(await asSystem(db, (tx) => tx<{ title: string; version: number }[]>`SELECT title, version FROM bookmarks WHERE id = ${bookmark}`)).toEqual([{ title: "Seed", version: 1 }]);
  }, TEST_TIMEOUT_MS);
});
