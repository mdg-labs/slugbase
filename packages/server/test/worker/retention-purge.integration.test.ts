import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { useTestDatabase } from "@slugbase/testing/db";
import { getConstructionPlans } from "pg-boss";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import { createWorker } from "../../src/worker/index.ts";
import type { JobDefinition, RunningWorker, Worker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { adapters, fakeDatabase, recordingLogger } from "../support.ts";

// The worker the CE image starts, with no module of its own, runs retention.purge
// every hour (doc 05 section 6, doc 01 section 8.1). The purge is a pg-boss job
// the worker registers and schedules; it reaches the tables as slugbase_app
// through sys_retention_purge and logs how many rows it deleted per table.

const database = useTestDatabase();

const JOB = "retention.purge";
const BATCH = 5_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function appUrl(): string {
  const { options } = database().app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

beforeAll(async () => {
  const owner = database().owner;
  const session = await owner.reserve();
  try {
    await session.unsafe(getConstructionPlans("pgboss", { createSchema: false }));
  } finally {
    session.release();
  }
}, 120_000);

const started: RunningWorker[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((worker) => worker.shutdown()));
});

function ceWorker(env: Record<string, string> = {}) {
  const logger = recordingLogger();
  const created = createWorker({
    config: loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl(), ...env }).config,
    adapters: adapters(),
    modules: [],
    logger,
    database: fakeDatabase(),
    pollingIntervalSeconds: 0.5,
  });
  return { created, logger };
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(100);
  }
}

let accountNumber = 0;

async function seedAccount(): Promise<string> {
  accountNumber += 1;
  const id = randomUUID();
  await database().owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${id}, true)`;
    await tx`
      INSERT INTO accounts (id, email, display_name, password_hash)
      VALUES (${id}, ${`worker-retention${String(accountNumber)}@example.test`}, 'Test account', '$argon2id$stub')`;
  });
  return id;
}

// `sessions` has forced row-level security and no policy; the owner reaches it as slugbase_system, the role of
// the system operations, which is what the fixtures and the assertions on the rows stand for.
async function seedSession(accountId: string, expiresInMs: number, absoluteExpiresInMs: number): Promise<string> {
  const id = randomUUID();
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO sessions (id, token_hash, account_id, level, remember, created_at, last_seen_at, expires_at, absolute_expires_at)
      VALUES (${id}, decode(md5(${id}) || md5(${id} || 'x'), 'hex'), ${accountId}, 'full', false,
              now() - interval '200 days', now() - interval '1 day',
              now() + ${expiresInMs} * interval '1 millisecond',
              now() + ${absoluteExpiresInMs} * interval '1 millisecond')`;
  });
  return id;
}

async function seedExpiredSessions(accountId: string, count: number): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO sessions (id, token_hash, account_id, level, remember, created_at, last_seen_at, expires_at, absolute_expires_at)
      SELECT gen_random_uuid(), decode(md5('a' || n::text) || md5('b' || n::text), 'hex'), ${accountId}, 'full', false,
             now() - interval '200 days', now() - interval '1 day',
             now() - interval '1 hour', now() + interval '10 days'
      FROM generate_series(1, ${count}) AS n`;
  });
}

async function sessionIds(): Promise<string[]> {
  const ids = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return (await tx<{ id: string }[]>`SELECT id FROM sessions ORDER BY id`).map((row) => row.id);
  });
  return ids;
}

async function clearSessions(): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`DELETE FROM sessions`;
  });
}

interface PurgeLog {
  readonly fields: Readonly<Record<string, unknown>>;
}

function purgeLogs(logger: ReturnType<typeof recordingLogger>): PurgeLog[] {
  return logger.entries.filter((entry) => entry.message === "Retention purge finished");
}

function deletedSessions(log: PurgeLog): number {
  const { deleted } = log.fields;
  if (typeof deleted === "object" && deleted !== null && "sessions" in deleted && typeof deleted.sessions === "number") {
    return deleted.sessions;
  }
  throw new Error("a purge log without a session count");
}

async function databaseNow(): Promise<Date> {
  const rows = await database().owner<{ at: Date }[]>`SELECT now() AS at`;
  return rows[0]?.at ?? new Date(0);
}

// The schedule fires at the top of the hour, whenever the suite happens to run, and a worker runs its first
// cron pass as it starts: a pass in the minute after the hour sends a tick, from the row an earlier test left
// or from the one this worker registers. A test that counts runs therefore holds pg-boss's cron claim while
// its worker starts, so no pass runs until the claim's interval is over, takes the schedule out of play, and
// gives the claim back. It enqueues every run itself; the next test's worker registers the schedule again.
async function startWithoutHourlySchedule(created: Worker): Promise<RunningWorker> {
  const owner = database().owner;
  const [prior] = await owner<{ cronOn: Date | null }[]>`SELECT cron_on AS "cronOn" FROM pgboss.version`;
  await owner`DELETE FROM pgboss.schedule WHERE name = ${JOB}`;
  await owner`UPDATE pgboss.version SET cron_on = pgboss.job_now()`;
  try {
    const running = await created.start();
    started.push(running);
    await owner`DELETE FROM pgboss.schedule WHERE name = ${JOB}`;
    return running;
  } finally {
    await owner`UPDATE pgboss.version SET cron_on = ${prior?.cronOn ?? null}`;
  }
}

async function enqueueRun(running: RunningWorker, job: JobDefinition): Promise<string> {
  const id = await running.enqueue(job, {});
  if (id === null) {
    throw new Error("the purge job was not enqueued");
  }
  return id;
}

// A tick a pass sent before the schedule was out of play would show up here as a job nobody enqueued.
async function expectOnlyEnqueuedRuns(since: Date, enqueued: readonly string[]): Promise<void> {
  const rows = await database().owner<{ id: string }[]>`
    SELECT id FROM pgboss.job WHERE name = ${JOB} AND created_on >= ${since}`;
  expect(rows.map((row) => row.id).sort()).toEqual([...enqueued].sort());
}

describe("the retention purge of a worker without modules", () => {
  it("registers the job and an hourly schedule", async () => {
    const { created } = ceWorker();
    expect(created.jobs.map((job) => job.name)).toContain(JOB);
    expect(created.schedules.filter((schedule) => schedule.job === JOB)).toEqual([
      { name: JOB, cron: "0 * * * *", job: JOB },
    ]);

    started.push(await created.start());

    const queues = await database().owner<{ name: string }[]>`SELECT name FROM pgboss.queue WHERE name = ${JOB}`;
    expect(queues.map((row) => row.name)).toEqual([JOB]);
    const schedules = await database().owner<{ key: string; cron: string }[]>`
      SELECT key, cron FROM pgboss.schedule WHERE name = ${JOB}`;
    expect(schedules).toEqual([{ key: JOB, cron: "0 * * * *" }]);
  });

  it("deletes expired and over-cap sessions when the job runs, keeps the live ones, and logs the counts only", async () => {
    await clearSessions();
    const mine = await seedAccount();
    const other = await seedAccount();
    const since = await databaseNow();
    await seedSession(mine, -HOUR_MS, 100 * DAY_MS);
    await seedSession(mine, 10 * DAY_MS, -HOUR_MS);
    await seedSession(other, -DAY_MS, -DAY_MS);
    const live = await seedSession(mine, 10 * DAY_MS, 100 * DAY_MS);
    const otherLive = await seedSession(other, HOUR_MS, 100 * DAY_MS);
    const { created, logger } = ceWorker();
    const running = await startWithoutHourlySchedule(created);
    const job = created.jobs.find((candidate) => candidate.name === JOB);
    expect(job).toBeDefined();
    if (job === undefined) {
      return;
    }

    const run = await enqueueRun(running, job);

    await until(() => purgeLogs(logger).length > 0, 15_000, "the purge job to run");
    expect(await sessionIds()).toEqual([live, otherLive].sort());
    expect(purgeLogs(logger).map((entry) => entry.fields)).toEqual([{ deleted: { sessions: 3, api_tokens: 0, oidc_login_states: 0, credential_tokens: 0, idempotency_keys: 0, audit_events: 0 } }]);
    await expectOnlyEnqueuedRuns(since, [run]);
  });

  describe("the audit log", () => {
    async function seedWorkspace(): Promise<string> {
      const id = randomUUID();
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`INSERT INTO workspaces (id, name) VALUES (${id}, 'Audited workspace')`;
      });
      return id;
    }

    async function seedAuditEvent(workspaceId: string, ageDays: number): Promise<string> {
      const id = randomUUID();
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`
          INSERT INTO audit_events (id, workspace_id, actor_type, actor_label, action, metadata, created_at)
          VALUES (${id}, ${workspaceId}, 'system', 'SlugBase', 'workspace.created', '{}'::jsonb, now() - ${ageDays} * interval '1 day')`;
      });
      return id;
    }

    async function auditIds(): Promise<string[]> {
      const rows = await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        return tx<{ id: string }[]>`SELECT id FROM audit_events ORDER BY id`;
      });
      return rows.map((row) => row.id);
    }

    async function clearAuditEvents(): Promise<void> {
      await database().owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`DELETE FROM audit_events`;
      });
    }

    async function runOnce(env: Record<string, string>): Promise<ReturnType<typeof purgeLogs>> {
      await clearSessions();
      const { created, logger } = ceWorker(env);
      const running = await startWithoutHourlySchedule(created);
      const job = created.jobs.find((candidate) => candidate.name === JOB);
      if (job === undefined) {
        throw new Error("the worker registers no retention job");
      }
      await enqueueRun(running, job);
      await until(() => purgeLogs(logger).length > 0, 15_000, "the purge job to run");
      return purgeLogs(logger);
    }

    it("deletes the events older than AUDIT_RETENTION_DAYS when the job runs, keeps the newer ones and logs the count", async () => {
      await clearAuditEvents();
      const workspaceId = await seedWorkspace();
      await seedAuditEvent(workspaceId, 90);
      await seedAuditEvent(workspaceId, 31);
      const recent = await seedAuditEvent(workspaceId, 29);
      const fresh = await seedAuditEvent(workspaceId, 0);

      const logs = await runOnce({ AUDIT_RETENTION_DAYS: "30" });

      expect(logs.map((entry) => entry.fields)).toEqual([
        { deleted: { sessions: 0, api_tokens: 0, oidc_login_states: 0, credential_tokens: 0, idempotency_keys: 0, audit_events: 2 } },
      ]);
      expect(await auditIds()).toEqual([recent, fresh].sort());
    });

    it("keeps every event with AUDIT_RETENTION_DAYS=0", async () => {
      await clearAuditEvents();
      const workspaceId = await seedWorkspace();
      const old = await seedAuditEvent(workspaceId, 4000);

      const logs = await runOnce({ AUDIT_RETENTION_DAYS: "0" });

      expect(logs.map((entry) => entry.fields)).toEqual([
        { deleted: { sessions: 0, api_tokens: 0, oidc_login_states: 0, credential_tokens: 0, idempotency_keys: 0, audit_events: 0 } },
      ]);
      expect(await auditIds()).toEqual([old]);
    });

    it("keeps events for a year when AUDIT_RETENTION_DAYS is not set", async () => {
      await clearAuditEvents();
      const workspaceId = await seedWorkspace();
      await seedAuditEvent(workspaceId, 366);
      const kept = await seedAuditEvent(workspaceId, 364);

      await runOnce({});

      expect(await auditIds()).toEqual([kept]);
    });
  });

  it("finishes a backlog of more than one batch across runs", async () => {
    await clearSessions();
    const owner = await seedAccount();
    const live = await seedSession(owner, DAY_MS, DAY_MS);
    const extra = 50;
    const since = await databaseNow();
    await seedExpiredSessions(owner, BATCH + extra);
    const { created, logger } = ceWorker();
    const running = await startWithoutHourlySchedule(created);
    const job = created.jobs.find((candidate) => candidate.name === JOB);
    expect(job).toBeDefined();
    if (job === undefined) {
      return;
    }

    const first = await enqueueRun(running, job);
    await until(() => purgeLogs(logger).length === 1, 15_000, "the first run");
    expect((await sessionIds()).length).toBe(extra + 1);

    const second = await enqueueRun(running, job);
    await until(() => purgeLogs(logger).length === 2, 15_000, "the second run");
    expect(await sessionIds()).toEqual([live]);
    expect(purgeLogs(logger).map((entry) => entry.fields)).toEqual([
      { deleted: { sessions: BATCH, api_tokens: 0, oidc_login_states: 0, credential_tokens: 0, idempotency_keys: 0, audit_events: 0 } },
      { deleted: { sessions: extra, api_tokens: 0, oidc_login_states: 0, credential_tokens: 0, idempotency_keys: 0, audit_events: 0 } },
    ]);
    await expectOnlyEnqueuedRuns(since, [first, second]);
  }, 60_000);

  it("runs once per tick when two workers start together, and the counts add up to the rows seeded", async () => {
    await clearSessions();
    const owner = await seedAccount();
    const live = await seedSession(owner, DAY_MS, DAY_MS);
    const expired = 3;
    for (let n = 0; n < expired; n += 1) {
      await seedSession(owner, -HOUR_MS, DAY_MS);
    }
    const since = await databaseNow();
    const first = ceWorker();
    const second = ceWorker();
    started.push(...(await Promise.all([first.created.start(), second.created.start()])));
    // The schedule fires at the top of the hour; the test moves it to every minute so a tick comes within the test.
    await database().owner`UPDATE pgboss.schedule SET cron = '* * * * *' WHERE name = ${JOB}`;

    // Each tick is forwarded as one row of pg-boss's own queue, filed under the tick's minute, and becomes one job.
    const jobs = async () =>
      database().owner<{ state: string }[]>`
        SELECT state FROM pgboss.job WHERE name = ${JOB} AND created_on >= ${since} ORDER BY created_on`;
    const ticks = async () =>
      database().owner<{ singleton_on: string }[]>`
        SELECT singleton_on::text AS singleton_on FROM pgboss.job
        WHERE name = '__pgboss__send-it' AND singleton_key = ${`${JOB}__${JOB}`} AND created_on >= ${since}`;
    await until(async () => (await jobs()).some((row) => row.state === "completed"), 150_000, "the first tick");
    await sleep(5000);

    const rows = await jobs();
    const runs = purgeLogs(first.logger).length + purgeLogs(second.logger).length;
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set((await ticks()).map((row) => row.singleton_on)).size).toBe(rows.length);
    expect(runs).toBe(rows.length);
    // Whichever tick ran first took the expired rows; the runs after it found none, so the counts add up to the seed.
    const purged = [...purgeLogs(first.logger), ...purgeLogs(second.logger)].reduce((sum, log) => sum + deletedSessions(log), 0);
    expect(purged).toBe(expired);
    expect(await sessionIds()).toEqual([live]);
    for (const { logger } of [first, second]) {
      expect(logger.entries.filter((entry) => entry.level === "error")).toEqual([]);
    }
  }, 240_000);
});
