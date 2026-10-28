import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QueueMissingError, enqueueInTenantTransaction, enqueueInTransaction, type QueuedJob } from "../src/system/queue.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// A job queued with a singleton key (doc 01 section 8.1): the queue of a `dedupe` job has the `short` policy of pg-boss, whose unique index holds one
// waiting job for each name and key, and the insert drops a second one (`ON CONFLICT DO NOTHING`) instead of failing the transaction that queues it. The
// failure scenario: a missing queue must stay an error, so that a job is never silently lost, and a dropped job must not abort the write it rides with.
// The queue and job tables are the ones `migrate` creates through pg-boss, reduced to the columns the enqueue writes, with the index of the policy.

const HOOK_TIMEOUT_MS = 300_000;
const QUEUE = "test.dedupe";

let db: TestDatabase;
let accountId: string;
let workspaceId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.owner.unsafe(`
    CREATE TABLE pgboss.queue (
      name text PRIMARY KEY, retention_seconds int NOT NULL, expire_seconds int NOT NULL, deletion_seconds int NOT NULL,
      retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL, retry_delay_max int,
      policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    CREATE TABLE pgboss.job (
      id uuid PRIMARY KEY, name text NOT NULL, data jsonb, singleton_key text, state text NOT NULL DEFAULT 'created',
      keep_until timestamptz NOT NULL, expire_seconds int NOT NULL,
      deletion_seconds int NOT NULL, retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL,
      retry_delay_max int, policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short';
    INSERT INTO pgboss.queue VALUES ('${QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'short', NULL, NULL);`);
  accountId = freshId();
  await seedAccount(db, { id: accountId, email: "queue-singleton@example.test", passwordHash: "$argon2id$stub", emailVerified: true });
  workspaceId = await seedWorkspace(db, { name: "Queue test" });
  await seedMember(db, { workspaceId, accountId, role: "owner" });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
});

const job = (singletonKey: string | undefined, queue = QUEUE): QueuedJob => ({
  id: freshId(),
  queue,
  data: { n: 1 },
  ...(singletonKey === undefined ? {} : { singletonKey }),
});

async function waiting(): Promise<{ id: string; singleton_key: string | null }[]> {
  return [...(await db.owner<{ id: string; singleton_key: string | null }[]>`SELECT id, singleton_key FROM pgboss.job ORDER BY singleton_key, id`)];
}

const variants: [string, (jobs: QueuedJob[]) => Promise<void>][] = [
  [
    "a tenant transaction",
    (jobs) =>
      db.tenant.withTenant({ accountId, workspaceId, requestId: "queue-singleton-test" }, async (tx) => {
        for (const queued of jobs) {
          await enqueueInTenantTransaction(tx, queued);
        }
      }),
  ],
  [
    "a transaction",
    (jobs) =>
      db.owner
        .begin(async (tx) => {
          for (const queued of jobs) {
            await enqueueInTransaction(tx, queued);
          }
        })
        .then(() => undefined),
  ],
];

describe.each(variants)("a job queued with a singleton key in %s", (_name, enqueue) => {
  it("is queued, with its key, when no job of the queue waits with that key", async () => {
    const first = job("workspace:page");

    await enqueue([first]);

    expect(await waiting()).toEqual([{ id: first.id, singleton_key: "workspace:page" }]);
  });

  it("is dropped, without an error, while a job with the same key waits, in the same transaction or in an earlier one", async () => {
    const first = job("workspace:page");
    await enqueue([first]);

    await expect(enqueue([job("workspace:page")])).resolves.toBeUndefined();
    await expect(enqueue([job("workspace:page"), job("workspace:page")])).resolves.toBeUndefined();

    expect(await waiting()).toEqual([{ id: first.id, singleton_key: "workspace:page" }]);
  });

  it("does not stop the writes of its transaction when it is dropped, and does not stop a job with another key", async () => {
    await enqueue([job("workspace:page")]);
    const other = job("workspace:other-page");

    await enqueue([job("workspace:page"), other]);

    expect((await waiting()).map((row) => row.singleton_key)).toEqual(["workspace:other-page", "workspace:page"]);
  });

  it("is queued again once the job that held its key is no longer waiting", async () => {
    await enqueue([job("workspace:page")]);
    await db.owner`UPDATE pgboss.job SET state = 'active'`;

    await enqueue([job("workspace:page")]);

    expect(await waiting()).toHaveLength(2);
  });

  it("is an error when the queue does not exist, so a job is never lost with the queue", async () => {
    await expect(enqueue([job("workspace:page", "test.nowhere")])).rejects.toBeInstanceOf(QueueMissingError);

    expect(await waiting()).toEqual([]);
  });

  it("is not queued when its transaction rolls back", async () => {
    await expect(
      enqueue([job("workspace:page"), { ...job(undefined), id: "not a uuid" }]),
    ).rejects.toBeInstanceOf(RangeError);

    expect(await waiting()).toEqual([]);
  });
});

describe("a job without a singleton key", () => {
  it("is an error when the queue does not exist, and is inserted as before otherwise", async () => {
    await expect(db.owner.begin((tx) => enqueueInTransaction(tx, job(undefined, "test.nowhere")))).rejects.toBeInstanceOf(QueueMissingError);

    await db.owner.begin((tx) => enqueueInTransaction(tx, job(undefined)));

    expect(await waiting()).toHaveLength(1);
  });
});
