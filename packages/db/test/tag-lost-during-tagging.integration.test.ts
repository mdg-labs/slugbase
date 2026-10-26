import type { BookmarkTagName } from "@slugbase/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookmarkRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// A tag that a tagging names and that a concurrent request deletes before the tagging has locked it (doc 05 section 2.4, doc 02 section 7.2). The creation
// of a bookmark reads the tags it names without a lock, before it takes its place under the ceiling; the locks on the tags come after the workspace's row and
// the new bookmark. The failure scenario: a tag the creation names by identifier is deleted and the deletion commits while the creation waits for the
// workspace's row, and the creation ends in an error (a server error over HTTP) instead of the `tag_not_found` that the same creation gets when the tag was
// gone before it started. The same for a name whose tag another request created and committed while the tagging was creating the tags of its names, and a third request deletes. Every
// refusal leaves nothing behind: no bookmark, no place under the ceiling, no link and no tag the request would have created.
//
// Each test holds the request at a lock, asserts with `pg_blocking_pids` who it waits for at each step, and deletes the tag only then, so the interleaving does
// not depend on timing.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
/** The key of the advisory lock that the trigger of the by-name tests asks for, and a holder keeps. */
const PAUSE_KEY = 5810;
const PAUSE_REQUEST_ID = "tag-lost-pause";

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
  await seedAccount(db, { id: owner, email: `tag-lost${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub" });
  const workspaceId = await seedWorkspace(db, { name: "Tag lost during tagging" });
  await seedMember(db, { workspaceId, accountId: owner, role: "owner" });
  return { workspaceId, owner };
}

function inTenant<T>(of: Scene, work: Parameters<typeof db.tenant.withTenant<T>>[1], requestId = "tag-lost"): Promise<T> {
  return db.tenant.withTenant({ accountId: of.owner, workspaceId: of.workspaceId, requestId }, work);
}

async function seedTag(of: Scene, name: string): Promise<string> {
  const id = freshId();
  await asSystem(db, (tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${id}, ${of.workspaceId}, ${of.owner}, ${name})`);
  return id;
}

async function deleteTag(tagId: string): Promise<void> {
  await asSystem(db, (tx) => tx`DELETE FROM tags WHERE id = ${tagId}`);
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

function named(...names: string[]): BookmarkTagName[] {
  return names.map((name) => ({ name, newId: freshId() }));
}

function newBookmark(of: Scene) {
  return { id: freshId(), ownerId: of.owner, url: "https://example.com/new", urlCanonical: "https://example.com/new", host: "example.com", title: "New", description: null, pinned: false };
}

/** What a refused tagging must not leave: the bookmarks, the count of the workspace, the links, and the names of the tags. */
async function stored(of: Scene): Promise<{ bookmarks: number; count: number; links: number; tags: string[] }> {
  return asSystem(db, async (tx) => {
    const [bookmarks] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmarks WHERE workspace_id = ${of.workspaceId}`;
    const [workspace] = await tx<{ n: number }[]>`SELECT bookmark_count AS n FROM workspaces WHERE id = ${of.workspaceId}`;
    const [links] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmark_tags WHERE workspace_id = ${of.workspaceId}`;
    const tags = await tx<{ name: string }[]>`SELECT name::text AS name FROM tags WHERE workspace_id = ${of.workspaceId} ORDER BY name`;
    return { bookmarks: bookmarks?.n ?? -1, count: workspace?.n ?? -1, links: links?.n ?? -1, tags: tags.map((tag) => tag.name) };
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

describe("a creation of a bookmark whose tag is deleted while it waits for the workspace", () => {
  it("answers tag_not_found for a tag named by identifier, and writes nothing, not even the tag a name would have created", async () => {
    const of = await scene();
    const kept = await seedTag(of, "Kept");
    const lost = await seedTag(of, "Lost");
    const held = await holdWorkspace(of);
    try {
      // The creation read both tags and now waits for the place under the ceiling, at the row of the workspace that the holder has.
      const created = settle(inTenant(of, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(of), ceiling: 5, jobs: [], tags: { ids: [kept, lost], names: named("Fresh") } })));
      const creating = await waitUntilOneWaits("the creation");
      await waitUntilBlockedBy(creating, [held.pid], "the creation waits at the workspace for the holder");
      await deleteTag(lost);
      held.release();

      expect(await created).toEqual({ kind: "tag_not_found" });
    } finally {
      held.release();
    }
    await held.done;
    expect(await stored(of)).toEqual({ bookmarks: 0, count: 0, links: 0, tags: ["Kept"] });
  }, TEST_TIMEOUT_MS);

  it("answers tag_not_found for a tag named by identifier that a request deletes between the lock on the workspace and the lock on the tags, and the place is given back", async () => {
    const of = await scene();
    const lost = await seedTag(of, "Lost");
    // A deletion of the tag that has not ended makes the creation wait at the tag, after it has read the tag, taken its place and inserted its bookmark.
    const deleting = await holder((tx) => tx`DELETE FROM tags WHERE id = ${lost}`);
    try {
      const created = settle(inTenant(of, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(of), ceiling: 5, jobs: [], tags: { ids: [lost], names: [] } })));
      const creating = await waitUntilOneWaits("the creation");
      await waitUntilBlockedBy(creating, [deleting.pid], "the creation waits at the tag for the deletion");
      deleting.release();

      expect(await created).toEqual({ kind: "tag_not_found" });
    } finally {
      deleting.release();
    }
    await deleting.done;
    expect(await stored(of)).toEqual({ bookmarks: 0, count: 0, links: 0, tags: [] });
  }, TEST_TIMEOUT_MS);
});

describe("a change of the tags of a bookmark whose tag is deleted while it waits for the bookmark", () => {
  it("answers tag_not_found for a tag named by identifier, and changes nothing", async () => {
    const of = await scene();
    const lost = await seedTag(of, "Lost");
    const bookmark = await seedBookmark(of);
    const held = await holder((tx) => tx`SELECT id FROM bookmarks WHERE id = ${bookmark} FOR UPDATE`);
    try {
      const changed = settle(
        inTenant(of, (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark, ownerId: of.owner, expectedVersions: undefined, changes: { title: "Changed", tags: { ids: [lost], names: named("Fresh") } } })),
      );
      const changing = await waitUntilOneWaits("the change");
      await waitUntilBlockedBy(changing, [held.pid], "the change waits at the bookmark for the holder");
      await deleteTag(lost);
      held.release();

      expect(await changed).toEqual({ kind: "tag_not_found" });
    } finally {
      held.release();
    }
    await held.done;
    expect(await stored(of)).toEqual({ bookmarks: 1, count: 0, links: 0, tags: [] });
    const titles = await asSystem(db, (tx) => tx<{ title: string; version: number }[]>`SELECT title, version FROM bookmarks WHERE id = ${bookmark}`);
    expect(titles).toEqual([{ title: "Seed", version: 1 }]);
  }, TEST_TIMEOUT_MS);
});

// A name the owner has no tag of is created by the tagging, after the tags it locks: its insert leaves a tag that another request made at the same time, and
// the read that follows finds it. The statement trigger below stops a request that carries `PAUSE_REQUEST_ID` once its insert of tags has run. The request
// that made the tag has committed by then, and a separate request deletes the tag in the gap between the insert and that read, so no timing decides it.
describe("a tagging by name against a tag that one request created and another deleted", () => {
  async function withPausingTrigger<T>(work: () => Promise<T>): Promise<T> {
    await db.owner.unsafe(`
      CREATE FUNCTION public.test_pause_after_tag_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('app.request_id', true) = '${PAUSE_REQUEST_ID}' THEN
          PERFORM pg_advisory_xact_lock(${String(PAUSE_KEY)});
        END IF;
        RETURN NULL;
      END $$`);
    await db.owner.unsafe("CREATE TRIGGER test_pause_after_tag_insert AFTER INSERT ON public.tags FOR EACH STATEMENT EXECUTE FUNCTION public.test_pause_after_tag_insert()");
    try {
      return await work();
    } finally {
      await db.owner.unsafe("DROP TRIGGER test_pause_after_tag_insert ON public.tags");
      await db.owner.unsafe("DROP FUNCTION public.test_pause_after_tag_insert()");
    }
  }

  /**
   * Runs `tagging` (a request of requestId `PAUSE_REQUEST_ID` that names `racer` and a new name) until it has inserted its tags, with `racer` made by a
   * transaction that commits meanwhile and deleted by a separate statement while the request waits for the pause; answers what the request answers.
   */
  async function raceRacerAway<T>(of: Scene, racer: string, tagging: () => Promise<T>): Promise<T | string> {
    return withPausingTrigger(async () => {
      const pause = await holder((tx) => tx`SELECT pg_advisory_xact_lock(${PAUSE_KEY})`);
      const making = await holder((tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${freshId()}, ${of.workspaceId}, ${of.owner}, ${racer})`);
      try {
        const answer = settle(tagging());
        // The request found no tag of the name (the one being made is not committed), inserted the new name, and waits at the insert of the name for the request making it.
        const waiting = await waitUntilOneWaits("the tagging");
        await waitUntilBlockedBy(waiting, [making.pid], "the tagging waits at the name for the request that makes it");
        making.release();
        await making.done;
        // The tag is committed, the insert left it, and the request waits at the pause before it reads its tags.
        await waitUntilBlockedBy(waiting, [pause.pid], "the tagging waits at the pause for the holder");
        await asSystem(db, (tx) => tx`DELETE FROM tags WHERE owner_id = ${of.owner} AND name = ${racer}`);
        pause.release();
        return await answer;
      } finally {
        making.release();
        pause.release();
        await Promise.all([making.done, pause.done]);
      }
    });
  }

  it("answers tag_not_found to a creation, and writes nothing", async () => {
    const of = await scene();
    const answer = await raceRacerAway(of, "Racer", () =>
      inTenant(of, (tx) => bookmarkRepository(tx).create({ bookmark: newBookmark(of), ceiling: 5, jobs: [], tags: { ids: [], names: named("Fresh", "Racer") } }), PAUSE_REQUEST_ID),
    );

    expect(answer).toEqual({ kind: "tag_not_found" });
    expect(await stored(of)).toEqual({ bookmarks: 0, count: 0, links: 0, tags: [] });
  }, TEST_TIMEOUT_MS);

  it("answers tag_not_found to a change, and writes nothing, not even the tag a name would have created", async () => {
    const of = await scene();
    const bookmark = await seedBookmark(of);
    const answer = await raceRacerAway(of, "Racer", () =>
      inTenant(
        of,
        (tx) => bookmarkRepository(tx).update({ bookmarkId: bookmark, ownerId: of.owner, expectedVersions: undefined, changes: { title: "Changed", tags: { ids: [], names: named("Fresh", "Racer") } } }),
        PAUSE_REQUEST_ID,
      ),
    );

    expect(answer).toEqual({ kind: "tag_not_found" });
    expect(await stored(of)).toEqual({ bookmarks: 1, count: 0, links: 0, tags: [] });
    expect(await asSystem(db, (tx) => tx<{ title: string; version: number }[]>`SELECT title, version FROM bookmarks WHERE id = ${bookmark}`)).toEqual([{ title: "Seed", version: 1 }]);
  }, TEST_TIMEOUT_MS);
});
