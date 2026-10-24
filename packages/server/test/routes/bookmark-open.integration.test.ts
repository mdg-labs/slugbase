import { createUsageStore, type OpenCount } from "@slugbase/db";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUsageBuffer, type UsageBuffer } from "../../src/usage/buffer.ts";
import { appUrl } from "../contract/support.ts";
import { recordingLogger } from "../support.ts";
import { bearer, HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST /api/v1/bookmarks/{id}/open (doc 04 section 10.6, doc 02 section 5.5, doc 01 section 8.1, doc 05 section 3.3, doc 10 section 5
// residual 1, T1, T2 and T12), through the whole chain over the migrated database, with the usage buffer writing to it through the
// system operation. The failure scenarios: a member of workspace A who names a bookmark of workspace B, or of a member who does not
// share it with them, and is answered the destination or has the open counted on it; an open that waits for the database; a count that
// is lost with more than the opens since the last flush when the process dies; and a counter that moves the bookmark's version, so
// every open would make an editor's `If-Match` stale.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const MANY = 4;

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

interface Bookmark {
  readonly id: string;
  readonly openCount: number;
  readonly lastOpenedAt: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

/** A usage buffer over the test database that records what each flush wrote; its timer is never started, so a test flushes when it means to. */
function observedBuffer(): { readonly usage: UsageBuffer; readonly written: OpenCount[][]; readonly close: () => Promise<void> } {
  const store = createUsageStore({ url: appUrl(database()), poolSize: 2 });
  const written: OpenCount[][] = [];
  const usage = createUsageBuffer({
    store: {
      flush: (opens) => {
        written.push([...opens]);
        return store.flush(opens);
      },
      close: () => store.close(),
    },
    logger: recordingLogger(),
  });
  return { usage, written, close: () => store.close() };
}

const open = (world: World, as: Person, id: string) => send(world, "POST", `${BOOKMARKS}/${id}/open`, { cookie: as.cookie });
const read = (world: World, as: Person, id: string) => send(world, "GET", `${BOOKMARKS}/${id}`, { cookie: as.cookie });

async function created(world: World, as: Person, title: string): Promise<Bookmark> {
  const response = await send(world, "POST", BOOKMARKS, { cookie: as.cookie }, { url: `https://example.com/${encodeURIComponent(title)}`, title });
  expect(response.status).toBe(201);
  return (await response.json()) as Bookmark;
}

interface Usage {
  readonly openCount: number;
  readonly lastOpenedAt: Date | null;
  readonly version: number;
}

async function usageOf(bookmarkId: string): Promise<Usage> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ open_count: string; last_opened_at: Date | null; version: number }[]>`SELECT open_count::text, last_opened_at, version FROM bookmarks WHERE id = ${bookmarkId}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no such bookmark");
  }
  return { openCount: Number(row.open_count), lastOpenedAt: row.last_opened_at, version: row.version };
}

/** A workspace of an owner and a member, and one of a stranger. */
async function setup(world: World) {
  const owner = await harness.person(world);
  const member = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: member, role: "member" },
  ]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, member, stranger, shared, other };
}

describe("openBookmark", () => {
  it(
    "answers the destination at once, counts the open in memory, and the flush adds it to the bookmark without moving its version or updatedAt",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage });
      const { owner } = await setup(world);
      const bookmark = await created(world, owner, "Docs");

      const first = await open(world, owner, bookmark.id);

      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ url: "https://example.com/Docs" });
      expect(await usageOf(bookmark.id)).toEqual({ openCount: 0, lastOpenedAt: null, version: 1 });
      expect(written).toEqual([]);

      for (let index = 1; index < MANY; index += 1) {
        expect((await open(world, owner, bookmark.id)).status).toBe(200);
      }
      await usage.flush();

      expect(written).toHaveLength(1);
      expect(written[0]).toEqual([{ bookmarkId: bookmark.id, count: MANY, lastOpenedAt: expect.any(Date) as Date }]);
      const flushed = await usageOf(bookmark.id);
      expect(flushed.openCount).toBe(MANY);
      expect(flushed.lastOpenedAt).toEqual(written[0]?.[0]?.lastOpenedAt);
      expect(flushed.version).toBe(1);
      const after = (await (await read(world, owner, bookmark.id)).json()) as Bookmark;
      expect(after).toMatchObject({ openCount: MANY, version: 1, updatedAt: bookmark.updatedAt });
      expect(after.lastOpenedAt).toBe(flushed.lastOpenedAt?.toISOString());

      await open(world, owner, bookmark.id);
      await usage.flush();
      expect((await usageOf(bookmark.id)).openCount).toBe(MANY + 1);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 404 for a bookmark of another workspace, and buffers nothing, so the other workspace's count does not move",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage });
      const { owner, stranger } = await setup(world);
      const theirs = await created(world, stranger, "Private to B");

      const response = await open(world, owner, theirs.id);

      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("not_found");
      await usage.flush();
      expect(written).toEqual([]);
      expect(await usageOf(theirs.id)).toEqual({ openCount: 0, lastOpenedAt: null, version: 1 });
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers the same 404 for another member's bookmark of the workspace, a plan-archived one and one that never existed, and counts none",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage });
      const { owner, member } = await setup(world);
      const members = await created(world, member, "Member's");
      const archived = await created(world, owner, "Archived");
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${archived.id}`;
      });

      const statuses = [
        (await open(world, owner, members.id)).status,
        (await open(world, owner, archived.id)).status,
        (await open(world, owner, "0192f3a0-ffff-7000-8000-000000000001")).status,
      ];

      expect(statuses).toEqual([404, 404, 404]);
      await usage.flush();
      expect(written).toEqual([]);
      expect((await usageOf(members.id)).openCount).toBe(0);
      expect((await usageOf(archived.id)).openCount).toBe(0);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "needs a session or a token that may write, and answers 422 for an identifier that is none",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage });
      const { owner, shared } = await setup(world);
      const bookmark = await created(world, owner, "Docs");
      const readOnly = await harness.token(shared.workspaceId, owner, "read");
      const readWrite = await harness.token(shared.workspaceId, owner, "read-write");
      const path = `${BOOKMARKS}/${bookmark.id}/open`;

      expect((await send(world, "POST", path, {})).status).toBe(401);
      const refused = await send(world, "POST", path, bearer(readOnly));
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("token_scope");
      expect((await send(world, "POST", `${BOOKMARKS}/not-an-id/open`, { cookie: owner.cookie })).status).toBe(422);
      await usage.flush();
      expect(written).toEqual([]);

      expect((await send(world, "POST", path, bearer(readWrite))).status).toBe(200);
      await usage.flush();
      expect(written.flat().map((entry) => entry.count)).toEqual([1]);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "takes from the go bucket: opens beyond its limit are 429 and are not counted",
    async () => {
      const { usage, written, close } = observedBuffer();
      const world = harness.serve({ usage, env: { RATE_LIMIT_GO_ACCOUNT: "2/min" } });
      const { owner } = await setup(world);
      const bookmark = await created(world, owner, "Docs");

      expect((await open(world, owner, bookmark.id)).status).toBe(200);
      expect((await open(world, owner, bookmark.id)).status).toBe(200);
      const limited = await open(world, owner, bookmark.id);

      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).not.toBeNull();
      await usage.flush();
      expect(written.flat().map((entry) => entry.count)).toEqual([2]);
      await usage.stop();
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "loses only the opens since the last flush when the buffer is dropped without one: what an earlier flush wrote stays",
    async () => {
      const first = observedBuffer();
      const world = harness.serve({ usage: first.usage });
      const { owner } = await setup(world);
      const bookmark = await created(world, owner, "Docs");

      // One interval: three opens, then the timer's flush.
      for (let index = 0; index < 3; index += 1) {
        expect((await open(world, owner, bookmark.id)).status).toBe(200);
      }
      await first.usage.flush();
      expect((await usageOf(bookmark.id)).openCount).toBe(3);

      // The next interval: two opens, then the process dies: the buffer is dropped, neither flushed nor stopped.
      for (let index = 0; index < 2; index += 1) {
        expect((await open(world, owner, bookmark.id)).status).toBe(200);
      }
      await first.close();

      expect(await usageOf(bookmark.id)).toMatchObject({ openCount: 3 });

      // A process that starts afterwards counts from what the database holds: nothing is double counted or restored.
      const second = observedBuffer();
      const restarted = harness.serve({ usage: second.usage });
      expect((await open(restarted, owner, bookmark.id)).status).toBe(200);
      await second.usage.flush();
      expect((await usageOf(bookmark.id)).openCount).toBe(4);
      await second.usage.stop();
      await second.close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "writes what is buffered when the server shuts down gracefully",
    async () => {
      const { usage, close } = observedBuffer();
      const world = harness.serve({ usage });
      const { owner } = await setup(world);
      const bookmark = await created(world, owner, "Docs");
      const running = await world.server.start({ port: 0 });

      for (let index = 0; index < 2; index += 1) {
        expect((await open(world, owner, bookmark.id)).status).toBe(200);
      }
      expect((await usageOf(bookmark.id)).openCount).toBe(0);
      await running.shutdown();

      expect((await usageOf(bookmark.id)).openCount).toBe(2);
      await close();
    },
    TEST_TIMEOUT_MS,
  );
});
