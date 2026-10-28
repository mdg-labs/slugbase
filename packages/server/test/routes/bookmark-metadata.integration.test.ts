import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { FakeEgress } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import { createWorker, type RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { appUrl, tenantDatabase } from "../contract/support.ts";
import { adapters, recordingLogger } from "../support.ts";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// POST and PATCH /api/v1/bookmarks queue the bookmark.fetchMetadata job in the transaction that writes the bookmark (doc 02 section 5.4, doc 01 section
// 8.1, doc 10 T13), through the whole chain over the migrated database, and the worker runs it. The failure scenario: a bookmark whose address is set
// or changed and whose page is never looked at (the job is not queued, or queued for a write that did not happen), or one looked at over and over (a
// job for every write although the address stayed, or several waiting jobs for one bookmark and page). The job carries identifiers and no address, a
// write that is refused or rolled back queues none, and the queue holds one waiting job for each bookmark and canonical URL: the job reads the
// bookmark's address when it runs, so a job keyed by the page alone could stand for a bookmark that has moved away from it.

const TEST_TIMEOUT_MS = 60_000;
const BOOKMARKS = "/api/v1/bookmarks";
const JOB = "bookmark.fetchMetadata";
const WAIT_MS = 20_000;

const database = useTestDatabase();
const harness = workspaceHarness(database);
let worker: RunningWorker | undefined;

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

afterEach(async () => {
  await worker?.shutdown();
  worker = undefined;
});

const create = (world: World, as: Person, body: unknown) => send(world, "POST", BOOKMARKS, { cookie: as.cookie }, body);
const patch = (world: World, as: Person, id: string, body: unknown, headers: Record<string, string> = {}) =>
  send(world, "PATCH", `${BOOKMARKS}/${id}`, { cookie: as.cookie, ...headers }, body);

async function created(world: World, as: Person, body: unknown): Promise<{ readonly id: string }> {
  const response = await create(world, as, body);
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

interface QueuedRow {
  readonly state: string;
  readonly singleton_key: string | null;
  readonly policy: string;
  readonly data: Record<string, unknown>;
}

async function queued(): Promise<QueuedRow[]> {
  return [...(await database().app<QueuedRow[]>`SELECT state, singleton_key, policy, data FROM pgboss.job WHERE name = ${JOB} ORDER BY created_on, id`)];
}

const keyOf = (workspaceId: string, bookmarkId: string, canonical: string): string =>
  `${workspaceId}:${bookmarkId}:${createHash("sha256").update(canonical).digest("hex")}`;

async function setup(world: World) {
  const owner = await harness.person(world);
  const stranger = await harness.person(world);
  const shared = await harness.workspaceOf([{ person: owner, role: "owner" }]);
  const other = await harness.workspaceOf([{ person: stranger, role: "owner" }]);
  return { owner, stranger, shared, other };
}

describe("creating a bookmark", () => {
  it(
    "queues one fetch of its page with the identifiers of the bookmark, its workspace and its owner, and no address",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);

      const bookmark = await created(world, owner, { url: "https://reader:secret@Example.com/Docs/?utm_source=feed&b=2&a=1#top", title: "Docs" });

      const [job, ...rest] = await queued();
      expect(rest).toEqual([]);
      expect(job).toMatchObject({ state: "created", policy: "short", singleton_key: keyOf(shared.workspaceId, bookmark.id, "https://example.com/Docs?a=1&b=2") });
      expect(job?.data).toEqual({ bookmarkId: bookmark.id, workspaceId: shared.workspaceId, accountId: owner.account.id });
      expect(JSON.stringify(job)).not.toMatch(/example\.com|secret|reader/i);
    },
    TEST_TIMEOUT_MS,
  );

  it("queues one fetch for each bookmark of a page, in its own workspace", async () => {
    const world = harness.serve();
    const { owner, stranger, shared, other } = await setup(world);

    const one = await created(world, owner, { url: "https://example.com/docs", title: "One" });
    const same = await created(world, owner, { url: "https://example.com/docs/?utm_campaign=x#again", title: "Same page" });
    const another = await created(world, owner, { url: "https://example.com/other", title: "Another page" });
    const elsewhere = await created(world, stranger, { url: "https://example.com/docs", title: "The same page in another workspace" });

    const keys = (await queued()).map((row) => row.singleton_key).sort();
    expect(keys).toEqual(
      [
        keyOf(shared.workspaceId, one.id, "https://example.com/docs"),
        keyOf(shared.workspaceId, same.id, "https://example.com/docs"),
        keyOf(shared.workspaceId, another.id, "https://example.com/other"),
        keyOf(other.workspaceId, elsewhere.id, "https://example.com/docs"),
      ].sort(),
    );
  });

  it("queues a fetch for a page whose waiting fetch belongs to a bookmark that has moved away from it", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const moved = await created(world, owner, { url: "https://example.com/docs", title: "Moved" });
    expect((await patch(world, owner, moved.id, { url: "https://example.com/elsewhere" })).status).toBe(200);

    const stays = await created(world, owner, { url: "https://example.com/docs", title: "Stays" });

    expect((await queued()).map((row) => row.singleton_key)).toContain(keyOf(shared.workspaceId, stays.id, "https://example.com/docs"));
  });

  it("queues nothing for a creation that is refused", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);

    expect((await create(world, owner, { url: "javascript:alert(1)", title: "Hostile" })).status).toBe(422);
    expect((await create(world, owner, { url: "https://example.com/", title: "Bad slug", slug: "NOT A SLUG!" })).status).toBe(422);
    expect((await create(world, owner, { url: "https://example.com/", title: "Missing folder", folderIds: ["0192f3a0-0000-7000-8000-000000000001"] })).status).toBe(404);
    await created(world, owner, { url: "https://example.com/", title: "Taken", slug: "taken" });
    await database().owner`TRUNCATE pgboss.job`;
    expect((await create(world, owner, { url: "https://example.com/again", title: "Taken again", slug: "taken" })).status).toBe(409);

    expect(await queued()).toEqual([]);
  });
});

describe("changing a bookmark", () => {
  it("queues a fetch when the address changes, and none for any other change or for the same address", async () => {
    const world = harness.serve();
    const { owner, shared } = await setup(world);
    const bookmark = await created(world, owner, { url: "https://example.com/docs", title: "Docs" });
    await database().owner`TRUNCATE pgboss.job`;

    for (const body of [{ title: "Renamed" }, { description: "Described" }, { pinned: true }, { url: "https://example.com/docs" }, { url: "https://EXAMPLE.com:443/docs" }]) {
      expect((await patch(world, owner, bookmark.id, body)).status).toBe(200);
    }
    expect(await queued()).toEqual([]);

    expect((await patch(world, owner, bookmark.id, { url: "https://example.org/moved?b=2&a=1" })).status).toBe(200);

    const [job, ...rest] = await queued();
    expect(rest).toEqual([]);
    expect(job).toMatchObject({ state: "created", singleton_key: keyOf(shared.workspaceId, bookmark.id, "https://example.org/moved?a=1&b=2") });
    expect(job?.data).toEqual({ bookmarkId: bookmark.id, workspaceId: shared.workspaceId, accountId: owner.account.id });
  });

  it("queues one waiting fetch when the address changes back to a page the bookmark already waits for, and another for a page it does not", async () => {
    const world = harness.serve();
    const { owner } = await setup(world);
    const bookmark = await created(world, owner, { url: "https://example.com/one", title: "One" });
    expect((await patch(world, owner, bookmark.id, { url: "https://example.com/two" })).status).toBe(200);
    expect(await queued()).toHaveLength(2);

    expect((await patch(world, owner, bookmark.id, { url: "https://example.com/one#section" })).status).toBe(200);
    expect(await queued()).toHaveLength(2);

    expect((await patch(world, owner, bookmark.id, { url: "https://example.com/three" })).status).toBe(200);
    expect(await queued()).toHaveLength(3);
  });

  it("queues nothing for a change that is stale, refused or not the caller's", async () => {
    const world = harness.serve();
    const { owner, stranger } = await setup(world);
    const bookmark = await created(world, owner, { url: "https://example.com/docs", title: "Docs" });
    await database().owner`TRUNCATE pgboss.job`;

    expect((await patch(world, owner, bookmark.id, { url: "https://example.com/a" }, { "if-match": '"7"' })).status).toBe(412);
    expect((await patch(world, owner, bookmark.id, { url: "javascript:alert(1)" })).status).toBe(422);
    expect((await patch(world, owner, bookmark.id, { url: "https://example.com/b", slug: "NOT A SLUG!" })).status).toBe(422);
    expect((await patch(world, stranger, bookmark.id, { url: "https://example.com/c" })).status).toBe(404);
    expect((await patch(world, owner, "0192f3a0-0000-7000-8000-000000000002", { url: "https://example.com/d" })).status).toBe(404);

    expect(await queued()).toEqual([]);
  });
});

describe("the worker", () => {
  it(
    "runs the queued fetch for a created and for a re-pointed bookmark, caches the page for the workspace and leaves the bookmark as entered",
    async () => {
      const world = harness.serve();
      const { owner, shared } = await setup(world);
      const egress = new FakeEgress({
        "https://example.com/docs": { contentType: "text/html", body: new TextEncoder().encode('<title>Docs title</title><meta name="description" content="Docs description"><html lang="en">') },
        "https://example.com/new": { contentType: "text/html", body: new TextEncoder().encode("<title>New title</title>") },
      });
      const config = loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(database()) }).config;
      worker = await createWorker({
        config,
        adapters: { ...adapters(), egress },
        modules: [],
        logger: recordingLogger(),
        database: tenantDatabase(database()),
        pollingIntervalSeconds: 0.5,
        shutdownTimeoutMs: 500,
      }).start();
      const results = async () =>
        database().owner.begin(async (tx) => {
          await tx`SET LOCAL ROLE slugbase_system`;
          return [...(await tx<{ url_canonical: string; status: string; title: string | null }[]>`SELECT url_canonical, status, title FROM url_metadata WHERE workspace_id = ${shared.workspaceId} ORDER BY url_canonical`)];
        });
      const until = async (check: () => Promise<boolean>, what: string): Promise<void> => {
        const deadline = Date.now() + WAIT_MS;
        while (!(await check())) {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
          }
          await sleep(100);
        }
      };

      const bookmark = await created(world, owner, { url: "https://example.com/docs", title: "As entered", description: "As entered too" });
      await until(async () => (await results()).length === 1, "the page of the new bookmark");
      expect(await results()).toEqual([{ url_canonical: "https://example.com/docs", status: "ok", title: "Docs title" }]);

      expect((await patch(world, owner, bookmark.id, { url: "https://example.com/new" })).status).toBe(200);
      await until(async () => (await results()).length === 2, "the page of the re-pointed bookmark");

      expect(await results()).toEqual([
        { url_canonical: "https://example.com/docs", status: "ok", title: "Docs title" },
        { url_canonical: "https://example.com/new", status: "ok", title: "New title" },
      ]);
      expect(egress.fetched).toEqual(["https://example.com/docs", "https://example.com/new"]);
      const stored = await send(world, "GET", `${BOOKMARKS}/${bookmark.id}`, { cookie: owner.cookie });
      expect(await stored.json()).toMatchObject({ title: "As entered", description: "As entered too", url: "https://example.com/new" });
      await until(async () => (await queued()).every((row) => row.state === "completed"), "the jobs to complete");
    },
    TEST_TIMEOUT_MS,
  );
});
