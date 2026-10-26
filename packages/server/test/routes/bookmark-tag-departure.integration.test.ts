import { useTestDatabase, type TestSql } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, MEMBERS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// PATCH /api/v1/bookmarks/{id} with `tagNames` while the same member is removed by DELETE /api/v1/members/{accountId} (doc 04 sections 10.4, 10.6 and
// 10.7, doc 05 section 2.4), through the whole chain over the migrated database. The failure scenario: a change that creates a tag by name holds its bookmark
// and then takes the owner's membership row through the foreign key of the new tag, while the removal holds that row and waits for the bookmark, and the
// database aborted one of the two with a deadlock (a 500). A change takes the workspace row and the membership row before its bookmark, so the removal
// queues behind it. Each request is held at a lock, who waits is read with `pg_blocking_pids`, and the requests end in their own answers.

const BOOKMARKS = "/api/v1/bookmarks";
const TAGS = "/api/v1/tags";
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;

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

class RolledBack extends Error {}

interface Created {
  readonly id: string;
}

async function asSystem<T>(work: (tx: SystemTx) => Promise<T>): Promise<T> {
  const result = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return { value: await work(tx) };
  });
  return result.value;
}

function gate(): { readonly open: () => void; readonly opened: Promise<void> } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * A transaction as slugbase_system that holds the locks `work` takes until `release` is called, and answers once it holds them (`pid` is its backend). `end` says
 * how it ends: `commit`, or `rollback`, which leaves nothing of what `work` wrote.
 */
async function holder(work: (tx: SystemTx) => Promise<unknown>, end: "commit" | "rollback"): Promise<{ readonly pid: number; readonly release: () => void; readonly done: Promise<void> }> {
  const held = gate();
  const release = gate();
  let pid = 0;
  const done = asSystem(async (tx) => {
    pid = (await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid ?? 0;
    await work(tx);
    held.open();
    await release.opened;
    if (end === "rollback") {
      throw new RolledBack();
    }
  }).then(
    () => undefined,
    (error: unknown) => {
      if (!(error instanceof RolledBack)) {
        throw error;
      }
    },
  );
  await Promise.race([held.opened, done]);
  return { pid, release: release.open, done };
}

/** The probes run on the application pool: the owner pool has two connections, and the holders may hold one. */
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

/** Waits until `count` backends wait for a lock and answers their pids. */
async function waitUntilWaiting(count: number, what: string): Promise<number[]> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  let waiting = await waitingPids();
  while (waiting.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never waited for a lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    waiting = await waitingPids();
  }
  expect(waiting, `${what}: only ${String(count)} backends should wait`).toHaveLength(count);
  return waiting;
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

async function setup(world: World) {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: member, role: "member" },
  ]);
  const kept = await createdTag(world, member, "Kept");
  const bookmark = await createdBookmark(world, member, "Seed");
  return { owner, member, workspaceId, kept, bookmark };
}

/** What a departure must leave: the member's bookmark without an owner, and none of the member's tags or links. */
async function stored(): Promise<{ tags: string[]; links: number; owners: (string | null)[]; members: number }> {
  return asSystem(async (tx) => ({
    tags: (await tx<{ name: string }[]>`SELECT name::text AS name FROM tags ORDER BY name`).map((row) => row.name),
    links: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bookmark_tags`)[0]?.n ?? -1,
    owners: (await tx<{ owner_id: string | null }[]>`SELECT owner_id FROM bookmarks ORDER BY id`).map((row) => row.owner_id),
    members: (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM workspace_members`)[0]?.n ?? -1,
  }));
}

describe("a change of a bookmark that names a new tag against the removal of its owner", () => {
  // The uncommitted tag "Fresh" stops the change at the insert of the new tag, with its bookmark and "Kept" locked. The removal arrives while it waits.
  it("answers 200 for the change and 200 for the removal, which waits for the change", async () => {
    const world = harness.serve();
    const { owner, member, workspaceId, kept, bookmark } = await setup(world);
    const pending = await holder(
      (tx) => tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${crypto.randomUUID()}, ${workspaceId}, ${member.account.id}, 'Fresh')`,
      "rollback",
    );
    let change: Promise<Response> | undefined;
    let removal: Promise<Response> | undefined;
    try {
      change = send(world, "PATCH", `${BOOKMARKS}/${bookmark.id}`, { cookie: member.cookie }, { tagIds: [kept.id], tagNames: ["Fresh"] });
      const [changePid] = await waitUntilWaiting(1, "the change");
      await waitUntilBlockedBy(changePid ?? 0, [pending.pid], "the change waits at the new tag for the uncommitted one");
      removal = send(world, "DELETE", `${MEMBERS}/${member.account.id}`, { cookie: owner.cookie }, { content: "transfer" });
      await waitUntilWaiting(2, "the removal");
    } finally {
      pending.release();
    }
    await pending.done;

    expect((await change).status).toBe(200);
    expect((await removal).status).toBe(200);
    expect(await stored()).toEqual({ tags: [], links: 0, owners: [null], members: 1 });
  }, TEST_TIMEOUT_MS);

  it("answers 404 for the change, and writes no tag and no link, when the removal holds the membership first", async () => {
    const world = harness.serve();
    const { member, workspaceId, kept, bookmark } = await setup(world);
    // The removal's own delete of the membership, kept open.
    const removing = await holder((tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId} AND account_id = ${member.account.id}`, "commit");
    let change: Promise<Response> | undefined;
    try {
      change = send(world, "PATCH", `${BOOKMARKS}/${bookmark.id}`, { cookie: member.cookie }, { tagIds: [kept.id], tagNames: ["Fresh"] });
      const [changePid] = await waitUntilWaiting(1, "the change");
      await waitUntilBlockedBy(changePid ?? 0, [removing.pid], "the change waits for the removal");
    } finally {
      removing.release();
    }
    await removing.done;

    expect((await change).status).toBe(404);
    expect(await stored()).toEqual({ tags: [], links: 0, owners: [null], members: 1 });
  }, TEST_TIMEOUT_MS);
});

