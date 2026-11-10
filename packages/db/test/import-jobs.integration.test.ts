import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importRepository } from "../src/index.ts";
import { QueueMissingError } from "../src/system/queue.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The events of an import's bookmarks (doc 02 section 13.1, doc 01 section 8.1). The import writes them in the transaction that holds the workspace's row lock, so the time that
// transaction takes is the time every other write to the workspace waits, and each of those waits holds a connection of the server's pool. The failure scenario: a request to the
// database for each event, so that a file of 5 000 bookmarks keeps the lock for the 5 000 round trips. The jobs of a batch are one statement, whatever the number of bookmarks in it.

const HOOK_TIMEOUT_MS = 300_000;
const QUEUE = "bookmark.created";

let db: TestDatabase;

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
    INSERT INTO pgboss.queue VALUES ('${QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'standard', NULL, NULL);
    CREATE TABLE public.job_statement_log (n bigserial PRIMARY KEY);
    CREATE FUNCTION public.log_job_statement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      INSERT INTO public.job_statement_log DEFAULT VALUES;
      RETURN NULL;
    END $$;
    CREATE TRIGGER job_statement AFTER INSERT ON pgboss.job FOR EACH STATEMENT EXECUTE FUNCTION public.log_job_statement();`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await db.owner`TRUNCATE pgboss.job`;
  await db.owner`TRUNCATE public.job_statement_log`;
});

let emailNumber = 0;
async function member(): Promise<{ accountId: string; workspaceId: string }> {
  emailNumber += 1;
  const accountId = freshId();
  await seedAccount(db, { id: accountId, email: `import-jobs${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  const workspaceId = await seedWorkspace(db, { name: "Import jobs test" });
  await seedMember(db, { workspaceId, accountId, role: "member" });
  return { accountId, workspaceId };
}

function bookmarkRow(id: string, ownerId: string) {
  return { id, ownerId, url: `https://example.com/${id}`, urlCanonical: `https://example.com/${id}`, host: "example.com", title: "T", description: null, pinned: false, slug: null, forwarding: false };
}

function jobFor(bookmarkId: string) {
  return { id: freshId(), queue: QUEUE, data: { eventId: freshId(), bookmarkId } };
}

describe("the jobs of an imported batch", () => {
  it("are all queued by one statement, with the settings of their queue and the data they were given", async () => {
    const { accountId, workspaceId } = await member();
    const ids = Array.from({ length: 500 }, () => freshId());
    const jobs = ids.map((id) => jobFor(id));

    await db.tenant.withTenant({ accountId, workspaceId, requestId: "import-jobs" }, async (tx) => {
      const repository = importRepository(tx);
      await repository.takePlaces(null, ids.length);
      await repository.insertBookmarks({ bookmarks: ids.map((id) => bookmarkRow(id, accountId)), jobs });
    });

    const statements = await db.owner<{ count: number }[]>`SELECT count(*)::int AS count FROM public.job_statement_log`;
    const stored = await db.owner<{ id: string; name: string; data: { eventId: string; bookmarkId: string }; retry_limit: number; expire_seconds: number; policy: string; singleton_key: string | null }[]>`
      SELECT id, name, data, retry_limit, expire_seconds, policy, singleton_key FROM pgboss.job ORDER BY data->>'bookmarkId'`;
    expect(statements[0]?.count).toBe(1);
    expect(stored).toHaveLength(ids.length);
    expect(stored.every((job) => job.name === QUEUE && job.retry_limit === 3 && job.expire_seconds === 900 && job.policy === "standard" && job.singleton_key === null)).toBe(true);
    expect(new Map(stored.map((job) => [job.id, job.data]))).toEqual(new Map(jobs.map((job) => [job.id, job.data])));
  });

  it("queue nothing and fail the import where a queue does not exist, so that no bookmark is left without its event", async () => {
    const { accountId, workspaceId } = await member();
    const ids = [freshId(), freshId()];
    const jobs = [jobFor(ids[0] ?? ""), { ...jobFor(ids[1] ?? ""), queue: "no.such.queue" }];

    await expect(
      db.tenant.withTenant({ accountId, workspaceId, requestId: "import-jobs" }, async (tx) => {
        const repository = importRepository(tx);
        await repository.takePlaces(null, ids.length);
        await repository.insertBookmarks({ bookmarks: ids.map((id) => bookmarkRow(id, accountId)), jobs });
      }),
    ).rejects.toBeInstanceOf(QueueMissingError);

    const rows = await asSystem(db, (tx) => tx<{ count: number }[]>`SELECT count(*)::int AS count FROM bookmarks WHERE workspace_id = ${workspaceId}`);
    const queued = await db.owner<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job`;
    expect(rows[0]?.count).toBe(0);
    expect(queued[0]?.count).toBe(0);
  });

  it("are not a statement at all where the batch has none", async () => {
    const { accountId, workspaceId } = await member();
    const id = freshId();

    await db.tenant.withTenant({ accountId, workspaceId, requestId: "import-jobs" }, async (tx) => {
      const repository = importRepository(tx);
      await repository.takePlaces(null, 1);
      await repository.insertBookmarks({ bookmarks: [bookmarkRow(id, accountId)], jobs: [] });
    });

    const statements = await db.owner<{ count: number }[]>`SELECT count(*)::int AS count FROM public.job_statement_log`;
    expect(statements[0]?.count).toBe(0);
  });
});
