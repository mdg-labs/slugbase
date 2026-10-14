import { setTimeout as sleep } from "node:timers/promises";
import { useTestDatabase } from "@slugbase/testing/db";
import { getConstructionPlans } from "pg-boss";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import { createWorker } from "../../src/worker/index.ts";
import type { RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { adapters, fakeDatabase, recordingLogger } from "../support.ts";

// The worker the CE image starts, with no module of its own, purges the buckets
// of the rate limiter that have been idle for an hour (doc 05 section 6). The
// purge runs as a pg-boss job that the worker registers and schedules, and
// reaches the table as slugbase_app through sys_rate_limit_purge.

const database = useTestDatabase();

const JOB = "rateLimit.purgeIdle";
const SCHEDULE = "rateLimit.purgeIdle";

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
  // The table has forced row-level security and no policy, so not even its owner reads it. This
  // test database is a throwaway clone: the fixtures and the assertions on the rows read it as its
  // owner once the force is lifted, while the purge under test still runs as slugbase_app through
  // the SECURITY DEFINER function, which the force never applied to.
  await owner.unsafe("ALTER TABLE public.rate_limit_buckets NO FORCE ROW LEVEL SECURITY");
}, 120_000);

const started: RunningWorker[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((worker) => worker.shutdown()));
});

function ceWorker() {
  return createWorker({
    config: loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl() }).config,
    adapters: adapters(),
    modules: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
    pollingIntervalSeconds: 0.5,
  });
}

async function keys(): Promise<string[]> {
  const rows = await database().owner<{ key: string }[]>`SELECT key FROM public.rate_limit_buckets ORDER BY key`;
  return rows.map((row) => row.key);
}

async function until(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(100);
  }
}

describe("the idle rate-limit bucket purge of a worker without modules", () => {
  it("registers the purge job and its schedule", async () => {
    const created = ceWorker();
    expect(created.jobs.map((job) => job.name)).toEqual([JOB]);
    expect(created.schedules.map((schedule) => schedule.name)).toEqual([SCHEDULE]);

    started.push(await created.start());

    const queues = await database().owner<{ name: string }[]>`SELECT name FROM pgboss.queue WHERE name = ${JOB}`;
    expect(queues.map((row) => row.name)).toEqual([JOB]);
    const schedules = await database().owner<{ key: string }[]>`SELECT key FROM pgboss.schedule WHERE name = ${JOB}`;
    expect(schedules.map((row) => row.key)).toEqual([SCHEDULE]);
  });

  it("deletes the buckets idle for more than an hour when the job runs, and keeps the others", async () => {
    await database().owner`
      INSERT INTO public.rate_limit_buckets (key, tokens, updated_at) VALUES
        ('worker:idle-2h', 0, now() - interval '2 hours'),
        ('worker:idle-61m', 3, now() - interval '61 minutes'),
        ('worker:recent-59m', 0, now() - interval '59 minutes'),
        ('worker:recent-now', 1, now())`;
    const created = ceWorker();
    const running = await created.start();
    started.push(running);
    const job = created.jobs.find((candidate) => candidate.name === JOB);
    expect(job).toBeDefined();
    if (job === undefined) {
      return;
    }

    await running.enqueue(job, {});

    await until(async () => !(await keys()).includes("worker:idle-2h"), 15_000, "the purge job to delete the idle buckets");
    expect(await keys()).toEqual(["worker:recent-59m", "worker:recent-now"]);
  });
});
