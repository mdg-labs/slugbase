import { useTestDatabase, type TestSql } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/bookmarks and PATCH /api/v1/bookmarks/{id} with `tagIds` and `tagNames` while a request deletes a tag they name (doc 04 sections 10.6 and
// 10.7, doc 02 section 7.2, doc 05 section 2.4), through the whole chain over the migrated database. The failure scenario: a tag that the request named
// is deleted, and the deletion commits, after the request read it and before it locked it, and the request answered 500 instead of the 404 `not_found` that the
// same request gets when the tag was gone before it started. Each request is held at a lock until the deletion has committed, who it waits for is read with
// `pg_blocking_pids`, and the refusal leaves nothing behind: no bookmark, no place under the ceiling, no link and no tag the request would have created.

const BOOKMARKS = "/api/v1/bookmarks";
const TAGS = "/api/v1/tags";
const UNKNOWN = "0192f3a0-aaaa-7000-8000-00000000dead";
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const PAUSE_KEY = 5811;

/** The transaction the owner pool hands to `begin`. */
type SystemTx = Parameters<Parameters<TestSql["begin"]>[1]>[0];

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface Problem {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;
}

interface Created {
  readonly id: string;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

async function createdTag(world: World, as: Person, name: string): Promise<Created> {
  const response = await send(world, "POST", TAGS, { cookie: as.cookie }, { name });
  expect(response.status).toBe(201);
  return (await response.json()) as Created;
}

async function createdBookmark(world: World, as: Person, title: string): Promise<Created> {
  const response = await send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: `https://example.com/${encodeURIComponent(title)}`, title });
  expect(response.status).toBe(201);
  return (await response.json()) as Created;
}

const postBookmark = (world: World, as: Person, body: unknown) => send(world, "POST", BOOKMARKS, { cookie: as.cookie }, body);
const patchBookmark = (world: World, as: Person, id: string, body: unknown) => send(world, "PATCH", `${BOOKMARKS}/${id}`, { cookie: as.cookie }, body);

async function asSystem<T>(work: (tx: SystemTx) => Promise<T>): Promise<T> {
  const result = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return { value: await work(tx) };
  });
  return result.value;
}

/** What a refused tagging must not leave, as the system reads it: the bookmarks, the count of the workspace, the links, and the names of the tags. */
async function stored(): Promise<{ bookmarks: string[]; count: number; links: number; tags: string[] }> {
  return asSystem(async (tx) => {
    const bookmarks = await tx<{ title: string }[]>`SELECT title FROM bookmarks ORDER BY title`;
    const [workspace] = await tx<{ n: number }[]>`SELECT bookmark_count AS n FROM workspaces`;
    const [links] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmark_tags`;
    const tags = await tx<{ name: string }[]>`SELECT name::text AS name FROM tags ORDER BY name`;
    return { bookmarks: bookmarks.map((row) => row.title), count: workspace?.n ?? -1, links: links?.n ?? -1, tags: tags.map((row) => row.name) };
  });
}

function gate(): { readonly open: () => void; readonly opened: Promise<void> } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** A transaction as slugbase_system that holds the locks `work` takes until `release` is called, and answers once it holds them (`pid` is its backend). */
async function holder(work: (tx: SystemTx) => Promise<unknown>): Promise<{ readonly pid: number; readonly release: () => void; readonly done: Promise<void> }> {
  const held = gate();
  const release = gate();
  let pid = 0;
  const done = asSystem(async (tx) => {
    pid = (await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid ?? 0;
    await work(tx);
    held.open();
    await release.opened;
  }).then(() => undefined);
  await Promise.race([held.opened, done]);
  return { pid, release: release.open, done };
}

/** The probes run on the application pool: the owner pool has two connections, and the holders may hold both. */
async function waitingPids(): Promise<number[]> {
  const rows = await database().app<{ pid: number }[]>`
    SELECT DISTINCT l.pid FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE NOT l.granted AND s.datname = current_database() ORDER BY l.pid`;
  return rows.map((row) => row.pid);
}

async function blockers(pid: number): Promise<number[]> {
  const rows = await database().app<{ pids: number[] }[]>`SELECT pg_blocking_pids(${pid}) AS pids`;
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

async function deleteTag(id: string): Promise<void> {
  await asSystem((tx) => tx`DELETE FROM tags WHERE id = ${id}`);
}

/** What the same request gets for a tag that was never there. */
async function unknownTagProblem(world: World, as: Person): Promise<Problem> {
  const response = await postBookmark(world, as, { url: "https://example.com/unknown", title: "Unknown", tagIds: [UNKNOWN] });
  expect(response.status).toBe(404);
  return problemOf(response);
}

async function setup(world: World) {
  const owner = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([{ person: owner, role: "owner" }]);
  return { owner, workspaceId };
}

describe("a tag that a concurrent request deletes while a tagging of a bookmark waits", () => {
  it("answers a creation that names it by identifier with the 404 of an unknown tag, and writes nothing", async () => {
    const world = harness.serve();
    const { owner, workspaceId } = await setup(world);
    const kept = await createdTag(world, owner, "Kept");
    const lost = await createdTag(world, owner, "Lost");
    const unknown = await unknownTagProblem(world, owner);
    // The creation reads both tags and waits for its place under the ceiling at the row of the workspace, which the holder has.
    const held = await holder((tx) => tx`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR NO KEY UPDATE`);
    let response: Promise<Response> | undefined;
    try {
      response = postBookmark(world, owner, { url: "https://example.com/new", title: "New", tagIds: [kept.id, lost.id], tagNames: ["Fresh"] });
      await waitUntilBlockedBy(await waitUntilOneWaits("the creation"), [held.pid], "the creation waits at the workspace for the holder");
      await deleteTag(lost.id);
    } finally {
      held.release();
    }
    await held.done;

    const answered = await response;
    expect(answered.status).toBe(404);
    expect(await problemOf(answered)).toMatchObject({ code: unknown.code, status: unknown.status, detail: unknown.detail });
    expect(await stored()).toEqual({ bookmarks: [], count: 0, links: 0, tags: ["Kept"] });
  }, TEST_TIMEOUT_MS);

  it("answers a change that names it by identifier with the 404 of an unknown tag, and changes nothing", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const lost = await createdTag(world, owner, "Lost");
    const bookmark = await createdBookmark(world, owner, "Seed");
    const unknown = await unknownTagProblem(world, owner);
    const held = await holder((tx) => tx`SELECT id FROM bookmarks WHERE id = ${bookmark.id} FOR UPDATE`);
    let response: Promise<Response> | undefined;
    try {
      response = patchBookmark(world, owner, bookmark.id, { title: "Changed", tagIds: [lost.id], tagNames: ["Fresh"] });
      await waitUntilBlockedBy(await waitUntilOneWaits("the change"), [held.pid], "the change waits at the bookmark for the holder");
      await deleteTag(lost.id);
    } finally {
      held.release();
    }
    await held.done;

    const answered = await response;
    expect(answered.status).toBe(404);
    expect(await problemOf(answered)).toMatchObject({ code: unknown.code, status: unknown.status, detail: unknown.detail });
    expect(await stored()).toEqual({ bookmarks: ["Seed"], count: 1, links: 0, tags: [] });
    expect(await asSystem((tx) => tx<{ title: string; version: number }[]>`SELECT title, version FROM bookmarks WHERE id = ${bookmark.id}`)).toEqual([{ title: "Seed", version: 1 }]);
  }, TEST_TIMEOUT_MS);

  // A name the owner has no tag of is created by the request. The trigger stops a request once its insert of the tag "Fresh" has run, and another request makes
  // and commits the tag "Racer", which the same insert leaves; a third request deletes it while the first waits, before the first reads its tags back.
  it("answers a creation that names it by name with the 404 of an unknown tag, and writes nothing", async () => {
    const world = harness.serve();
    const { owner, workspaceId } = await setup(world);
    const unknown = await unknownTagProblem(world, owner);
    await database().owner.unsafe(`
      CREATE FUNCTION public.test_pause_after_fresh_tag() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${String(PAUSE_KEY)});
        RETURN NULL;
      END $$`);
    await database().owner.unsafe("CREATE TRIGGER test_pause_after_fresh_tag AFTER INSERT ON public.tags FOR EACH ROW WHEN (NEW.name = 'Fresh') EXECUTE FUNCTION public.test_pause_after_fresh_tag()");
    try {
      const pause = await holder((tx) => tx`SELECT pg_advisory_xact_lock(${PAUSE_KEY})`);
      const making = await holder((tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${owner.account.id}, 'Racer')`);
      let response: Promise<Response> | undefined;
      try {
        response = postBookmark(world, owner, { url: "https://example.com/new", title: "New", tagNames: ["Fresh", "Racer"] });
        // The request found no tag of the names (the one being made is not committed) and waits at the insert of "Racer" for the request that makes it.
        const waiting = await waitUntilOneWaits("the creation");
        await waitUntilBlockedBy(waiting, [making.pid], "the creation waits at the name for the request that makes it");
        making.release();
        await making.done;
        // The tag is committed, the insert left it, and the request waits at the pause before it reads its tags back.
        await waitUntilBlockedBy(waiting, [pause.pid], "the creation waits at the pause for the holder");
        await asSystem((tx) => tx`DELETE FROM tags WHERE name = 'Racer'`);
      } finally {
        making.release();
        pause.release();
        await Promise.all([making.done, pause.done]);
      }

      const answered = await response;
      expect(answered.status).toBe(404);
      expect(await problemOf(answered)).toMatchObject({ code: unknown.code, status: unknown.status, detail: unknown.detail });
    } finally {
      await database().owner.unsafe("DROP TRIGGER test_pause_after_fresh_tag ON public.tags");
      await database().owner.unsafe("DROP FUNCTION public.test_pause_after_fresh_tag()");
    }
    expect(await stored()).toEqual({ bookmarks: [], count: 0, links: 0, tags: [] });
  }, TEST_TIMEOUT_MS);
});
