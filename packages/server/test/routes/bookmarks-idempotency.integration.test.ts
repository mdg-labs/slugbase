import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { LimitedEntitlementSource } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queuedJobCount } from "../invitations/support.ts";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// The Idempotency-Key of POST /api/v1/bookmarks through the whole chain over the migrated database (doc 04 section 6.3, doc 05
// section 2.10, doc 10 T1 and T11). The failure scenarios: two requests with one key that both run and so store a bookmark twice;
// a retry that creates a second bookmark or that is refused at the ceiling the first creation filled; one key replayed against
// another request or another workspace; the same UUID of two accounts colliding; and a refused creation that leaves its key behind
// and so replays an answer that never happened.

const BOOKMARKS = "/api/v1/bookmarks";
const KEY_HEADER = "idempotency-key";
const REPLAYED_HEADER = "idempotency-replayed";
const CREATED_JOB = "event.bookmark.created";
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

function create(world: World, person: Person, body: unknown, key?: string): Promise<Response> {
  return send(world, "POST", BOOKMARKS, { cookie: person.cookie, ...(key === undefined ? {} : { [KEY_HEADER]: key }) }, body);
}

const BODY = { url: "https://example.com/docs", title: "Docs" };

interface Stored {
  readonly rows: number;
  readonly counter: number;
  readonly jobs: number;
}

async function stored(workspaceId: string): Promise<Stored> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ rows: number; counter: number }[]>`
      SELECT (SELECT count(*) FROM bookmarks WHERE workspace_id = ${workspaceId})::int AS rows, (SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}) AS counter`;
  });
  return { rows: rows[0]?.rows ?? -1, counter: rows[0]?.counter ?? -1, jobs: await queuedJobCount(database(), CREATED_JOB) };
}

interface KeyRow {
  readonly account_id: string;
  readonly operation: string;
  readonly status: string;
  readonly response_status: number | null;
}

async function keysOf(key: string): Promise<KeyRow[]> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<KeyRow[]>`SELECT account_id, operation, status, response_status FROM idempotency_keys WHERE key = ${key} ORDER BY account_id`;
  });
  return [...rows];
}

async function problemCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

/** How many backends wait for a lock on a table of this database. */
async function tableWaiters(): Promise<number> {
  const rows = await database().owner<{ count: number }[]>`
    SELECT count(*)::int AS count FROM pg_locks
    WHERE NOT granted AND locktype = 'relation' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return rows[0]?.count ?? 0;
}

/** How many backends wait for a transaction that has locked something in this database to end: a request waiting on the key another holds. */
async function transactionWaiters(): Promise<number> {
  const rows = await database().owner<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM pg_locks waiting
    JOIN pg_locks holder ON holder.locktype = 'transactionid' AND holder.transactionid = waiting.transactionid AND holder.granted AND holder.pid <> waiting.pid
    WHERE waiting.locktype = 'transactionid' AND NOT waiting.granted
      AND EXISTS (
        SELECT 1 FROM pg_locks held
        WHERE held.pid = holder.pid AND held.locktype = 'relation' AND held.database = (SELECT oid FROM pg_database WHERE datname = current_database()))`;
  return rows[0]?.count ?? 0;
}

/** Two workspaces, each with an owner, who creates bookmarks. */
async function workspaces(world: World) {
  const mine = await harness.person(world);
  const theirs = await harness.person(world);
  const first = await harness.workspaceOf([{ person: mine, role: "owner" }]);
  const second = await harness.workspaceOf([{ person: theirs, role: "owner" }]);
  return { mine, theirs, first, second };
}

describe("POST /api/v1/bookmarks with an Idempotency-Key", { timeout: TEST_TIMEOUT_MS }, () => {
  it("stores one bookmark of two requests with one key that arrive at the same moment, and answers both with the one response", async () => {
    const world = harness.serve();
    const { mine, first } = await workspaces(world);
    const key = randomUUID();

    // A lock on the table holds the first request inside its transaction, key claimed, until the second has arrived at the key,
    // so the two overlap whatever the speed of the machine.
    const lock = await database().owner.reserve();
    let one: Promise<Response>;
    let two: Promise<Response>;
    try {
      await lock`BEGIN`;
      await lock`LOCK TABLE bookmarks IN SHARE ROW EXCLUSIVE MODE`;
      one = create(world, mine, BODY, key);
      await until(async () => (await tableWaiters()) >= 1, "the first request to wait on the table");
      two = create(world, mine, BODY, key);
      await until(async () => (await transactionWaiters()) >= 1, "the second request to wait on the key");
      await lock`COMMIT`;
    } finally {
      lock.release();
    }
    const responses = await Promise.all([one, two]);

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses.map((response) => response.headers.get(REPLAYED_HEADER)).sort()).toEqual([null, "true"]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string }>));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(await stored(first.workspaceId)).toEqual({ rows: 1, counter: 1, jobs: 1 });
    expect((await keysOf(key)).map((row) => [row.operation, row.status, row.response_status])).toEqual([["createBookmark", "done", 201]]);
  });

  it("stores one bookmark of many parallel requests with one key, with no help to line them up", async () => {
    const world = harness.serve();
    const { mine, first } = await workspaces(world);
    const key = randomUUID();

    const responses = await Promise.all(Array.from({ length: 6 }, () => create(world, mine, BODY, key)));

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(responses.filter((response) => response.headers.get(REPLAYED_HEADER) === null)).toHaveLength(1);
    expect(new Set(await Promise.all(responses.map(async (response) => ((await response.json()) as { id: string }).id))).size).toBe(1);
    expect(await stored(first.workspaceId)).toEqual({ rows: 1, counter: 1, jobs: 1 });
  });

  it("answers a retry with the stored response and Idempotency-Replayed: true, and stores, counts and announces nothing again", async () => {
    const world = harness.serve();
    const { mine, first } = await workspaces(world);
    const key = randomUUID();

    const original = await create(world, mine, { title: "Docs", url: "https://example.com/docs" }, key);
    const retry = await create(world, mine, { url: "https://example.com/docs", title: "Docs" }, key.toUpperCase());

    expect(original.status).toBe(201);
    expect(original.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(retry.status).toBe(201);
    expect(retry.headers.get(REPLAYED_HEADER)).toBe("true");
    expect(retry.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await retry.json()).toEqual(await original.json());
    expect(await stored(first.workspaceId)).toEqual({ rows: 1, counter: 1, jobs: 1 });
    expect(await keysOf(key)).toHaveLength(1);
  });

  it("makes a bookmark for every request that carries no key", async () => {
    const world = harness.serve();
    const { mine, first } = await workspaces(world);

    const one = await create(world, mine, BODY);
    const two = await create(world, mine, BODY);

    expect([one.status, two.status]).toEqual([201, 201]);
    expect(two.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(await stored(first.workspaceId)).toEqual({ rows: 2, counter: 2, jobs: 2 });
  });

  it("answers a retry with the stored response although the first creation filled the workspace's ceiling", async () => {
    const world = harness.serve({ entitlementSource: new LimitedEntitlementSource().grant("bookmarks.max", 1) });
    const { mine, first } = await workspaces(world);
    const key = randomUUID();

    const original = await create(world, mine, BODY, key);
    const retry = await create(world, mine, BODY, key);
    const another = await create(world, mine, { url: "https://example.com/other", title: "Other" }, randomUUID());

    expect(original.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers.get(REPLAYED_HEADER)).toBe("true");
    expect(another.status).toBe(422);
    expect(await problemCode(another)).toBe("bookmark_limit_reached");
    expect(await stored(first.workspaceId)).toEqual({ rows: 1, counter: 1, jobs: 1 });
  });

  it("answers 409 idempotency_conflict for the key of another request, and stores nothing for it", async () => {
    const world = harness.serve();
    const { mine, first } = await workspaces(world);
    const key = randomUUID();
    await create(world, mine, BODY, key);

    const otherTitle = await create(world, mine, { ...BODY, title: "Another title" }, key);
    const otherUrl = await create(world, mine, { ...BODY, url: "https://example.com/other" }, key);
    const otherPin = await create(world, mine, { ...BODY, pinned: true }, key);
    const replay = await create(world, mine, BODY, key);

    for (const conflict of [otherTitle, otherUrl, otherPin]) {
      expect(conflict.status).toBe(409);
      expect(await problemCode(conflict)).toBe("idempotency_conflict");
      expect(conflict.headers.get(REPLAYED_HEADER)).toBeNull();
    }
    expect(replay.status).toBe(201);
    expect(replay.headers.get(REPLAYED_HEADER)).toBe("true");
    expect(await stored(first.workspaceId)).toEqual({ rows: 1, counter: 1, jobs: 1 });
  });

  it("keeps the keys of two accounts apart: the same UUID and request from another account stores its own bookmark and never sees the other's response", async () => {
    const world = harness.serve();
    const { mine, theirs, first, second } = await workspaces(world);
    const key = randomUUID();

    const original = await create(world, mine, BODY, key);
    const other = await create(world, theirs, BODY, key);

    expect([original.status, other.status]).toEqual([201, 201]);
    expect(other.headers.get(REPLAYED_HEADER)).toBeNull();
    const originalBody = (await original.json()) as { id: string; ownerId: string };
    const otherBody = (await other.json()) as { id: string; ownerId: string };
    expect(otherBody.id).not.toBe(originalBody.id);
    expect(otherBody.ownerId).toBe(theirs.account.id);
    expect(await stored(first.workspaceId)).toMatchObject({ rows: 1, counter: 1 });
    expect(await stored(second.workspaceId)).toMatchObject({ rows: 1, counter: 1 });
    expect((await keysOf(key)).map((row) => row.account_id).sort()).toEqual([mine.account.id, theirs.account.id].sort());
  });

  it("stores nothing for a creation that is refused: the key is free for the retry, which runs", async () => {
    const world = harness.serve();
    const { mine, first } = await workspaces(world);
    const key = randomUUID();

    const hostile = await create(world, mine, { url: "javascript:alert(1)", title: "Hostile" }, key);
    const malformed = await create(world, mine, { url: "", title: "Empty" }, key);

    expect(hostile.status).toBe(422);
    expect(await problemCode(hostile)).toBe("url_not_allowed");
    expect(malformed.status).toBe(422);
    expect(await keysOf(key)).toEqual([]);
    expect(await stored(first.workspaceId)).toEqual({ rows: 0, counter: 0, jobs: 0 });
    const retry = await create(world, mine, BODY, key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(await stored(first.workspaceId)).toEqual({ rows: 1, counter: 1, jobs: 1 });
  });

  it("leaves no key behind for a creation refused at the ceiling, and runs the retry once the ceiling has risen", async () => {
    const source = new LimitedEntitlementSource().grant("bookmarks.max", 0);
    const world = harness.serve({ entitlementSource: source });
    const { mine, first } = await workspaces(world);
    const key = randomUUID();

    const refused = await create(world, mine, BODY, key);

    expect(refused.status).toBe(422);
    expect(await problemCode(refused)).toBe("bookmark_limit_reached");
    expect(await keysOf(key)).toEqual([]);
    source.grant("bookmarks.max", 5);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE workspaces SET entitlement_version = entitlement_version + 1 WHERE id = ${first.workspaceId}`;
    });
    const retry = await create(world, mine, BODY, key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(await stored(first.workspaceId)).toEqual({ rows: 1, counter: 1, jobs: 1 });
  });

  it("refuses a key that is not a UUID, and several keys, with 400 bad_request and stores nothing", async () => {
    const world = harness.serve();
    const { mine, first } = await workspaces(world);

    for (const key of ["", "not-a-uuid", `${randomUUID()}, ${randomUUID()}`, `${randomUUID()}x`]) {
      const response = await create(world, mine, BODY, key);
      expect(response.status).toBe(400);
      expect(await problemCode(response)).toBe("bad_request");
    }
    expect(await stored(first.workspaceId)).toEqual({ rows: 0, counter: 0, jobs: 0 });
  });

  it("treats a key past its 24 hours as unused: the request runs again and is not a replay", async () => {
    const world = harness.serve();
    const { mine, first } = await workspaces(world);
    const key = randomUUID();
    await create(world, mine, BODY, key);
    await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      await tx`UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = ${key}`;
    });

    const again = await create(world, mine, BODY, key);

    expect(again.status).toBe(201);
    expect(again.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(await stored(first.workspaceId)).toEqual({ rows: 2, counter: 2, jobs: 2 });
    expect(await keysOf(key)).toHaveLength(1);
  });

  it("scopes a token's key to the account of its owner", async () => {
    const world = harness.serve();
    const { mine, first } = await workspaces(world);
    const token = await harness.token(first.workspaceId, mine, "read-write");
    const key = randomUUID();

    const viaToken = await send(world, "POST", BOOKMARKS, { ...bearer(token), [KEY_HEADER]: key }, BODY);
    const viaSession = await create(world, mine, BODY, key);

    expect(viaToken.status).toBe(201);
    expect(viaSession.status).toBe(201);
    expect(viaSession.headers.get(REPLAYED_HEADER)).toBe("true");
    expect(await stored(first.workspaceId)).toEqual({ rows: 1, counter: 1, jobs: 1 });
  });
});
