import { setTimeout as sleep } from "node:timers/promises";
import { useTestDatabase } from "@slugbase/testing/db";
import { getConstructionPlans } from "pg-boss";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config/index.ts";
import { NotIdempotentError, assertIdempotent, createWorker, defineJob, defineSchedule } from "../src/worker/index.ts";
import type { JobDefinition, RunningWorker } from "../src/worker/index.ts";
import type { ServerModule } from "../src/create-server.ts";
import { adapters, fakeDatabase, moduleContext, recordingLogger } from "./support.ts";
import { productionEnv } from "./config/support.ts";

// Worker instances on a migrated database, connected as slugbase_app (doc 01
// section 3). The pg-boss schema is installed here as the owner role, the way
// `migrate` will install it; the grants come from the declarative SQL.

const database = useTestDatabase();

const POLL_SECONDS = 0.5;
const payload = z.object({ id: z.string() });
const noPayload = z.object({});

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

function workerConfig() {
  return loadConfig("worker", { ...productionEnv(), NODE_ENV: "test", DATABASE_URL: appUrl() }).config;
}

beforeAll(async () => {
  const owner = database().owner;
  // The plans carry their own BEGIN and COMMIT, which need one session.
  const session = await owner.reserve();
  try {
    await session.unsafe(getConstructionPlans("pgboss", { createSchema: false }));
  } finally {
    session.release();
  }
  await owner.unsafe(`
    CREATE TABLE public.worker_probe (id text PRIMARY KEY, runs int NOT NULL DEFAULT 1);
    GRANT SELECT, INSERT, UPDATE ON public.worker_probe TO slugbase_app;
  `);
}, 120_000);

const started: RunningWorker[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((worker) => worker.shutdown()));
});

async function startWorker(modules: ServerModule[], shutdownTimeoutMs?: number) {
  const logger = recordingLogger();
  const fake = fakeDatabase();
  const worker = createWorker({
    config: workerConfig(),
    adapters: adapters(),
    modules,
    logger,
    database: fake,
    pollingIntervalSeconds: POLL_SECONDS,
    ...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }),
  });
  const running = await worker.start();
  started.push(running);
  return { running, logger, fake };
}

function moduleOf(name: string, jobs: JobDefinition[], schedules: ReturnType<typeof defineSchedule>[] = []): ServerModule {
  return { name, register: () => ({ jobs, schedules }) };
}

interface JobRow {
  state: string;
  retry_count: number;
  retry_limit: number;
  retry_delay: number;
  retry_backoff: boolean;
  singleton_on: string | null;
}

async function jobRows(queue: string): Promise<JobRow[]> {
  return database().app<JobRow[]>`
    SELECT state, retry_count, retry_limit, retry_delay, retry_backoff, singleton_on::text AS singleton_on
    FROM pgboss.job WHERE name = ${queue} ORDER BY created_on`;
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

describe("two workers on one database", () => {
  it("runs a job once, on one of them", async () => {
    const runs: string[] = [];
    const jobFor = (instance: string) =>
      defineJob({
        name: "test.runOnce",
        payload,
        handle: (data) => {
          runs.push(`${instance}:${data.id}`);
          return Promise.resolve();
        },
      });
    const first = await startWorker([moduleOf("a", [jobFor("a")])]);
    await startWorker([moduleOf("b", [jobFor("b")])]);

    await first.running.enqueue(jobFor("a"), { id: "one" });
    await until(async () => (await jobRows("test.runOnce")).every((row) => row.state === "completed") && runs.length > 0, 20_000, "the job");
    await sleep(2000);

    expect(runs).toHaveLength(1);
    expect(await jobRows("test.runOnce")).toHaveLength(1);
  });

  it("runs a schedule once per tick across both", async () => {
    const runs: string[] = [];
    const jobFor = (instance: string) =>
      defineJob({
        name: "test.tick",
        payload: noPayload,
        handle: () => {
          runs.push(instance);
          return Promise.resolve();
        },
      });
    const schedule = defineSchedule({ name: "test.tickEveryMinute", cron: "* * * * *", job: "test.tick" });
    const first = await startWorker([moduleOf("a", [jobFor("a")], [schedule])]);
    const second = await startWorker([moduleOf("b", [jobFor("b")], [schedule])]);

    await until(() => runs.length > 0, 120_000, "the first tick");
    await sleep(5000);

    const rows = await jobRows("test.tick");
    expect(rows.length).toBeGreaterThan(0);
    expect(runs).toHaveLength(rows.length);
    expect(new Set(rows.map((row) => row.singleton_on)).size).toBe(rows.length);
    const registered = await database().app<{ key: string }[]>`SELECT key FROM pgboss.schedule WHERE name = 'test.tick'`;
    expect(registered).toEqual([{ key: "test.tickEveryMinute" }]);
    // pg-boss maintenance and cron run as slugbase_app on the granted rights alone.
    for (const { logger } of [first, second]) {
      expect(logger.entries.filter((entry) => entry.level === "error")).toEqual([]);
    }
  }, 180_000);

  it("retries a failing job with backoff and ends it failed after its attempts", async () => {
    const attempts: number[] = [];
    const failing = defineJob({
      name: "test.failing",
      payload,
      retry: { limit: 2, delaySeconds: 1, backoff: true },
      handle: () => {
        attempts.push(Date.now());
        return Promise.reject(new Error("always fails"));
      },
    });
    const first = await startWorker([moduleOf("a", [failing])]);
    const second = await startWorker([moduleOf("b", [failing])]);

    await first.running.enqueue(failing, { id: "x" });
    await until(async () => (await jobRows("test.failing")).some((row) => row.state === "failed"), 60_000, "the job to fail");

    const [row] = await jobRows("test.failing");
    expect(row).toMatchObject({ state: "failed", retry_count: 2, retry_limit: 2, retry_delay: 1, retry_backoff: true });
    // Either worker may take any attempt, so the failures are read from both logs.
    const failures = [first, second].flatMap(({ logger }) => logger.entries.filter((entry) => entry.message === "Job failed"));
    expect(failures.map((entry) => entry.fields.attempt).sort()).toEqual([1, 2, 3]);
    expect(attempts).toHaveLength(3);
    // Only lower bounds: database latency can stretch a gap, never shorten it. The retry delay
    // doubles per retry, so the second gap is at least twice the configured delay.
    const gaps = attempts.slice(1).map((at, index) => at - (attempts[index] ?? 0));
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toBeGreaterThanOrEqual(900);
    expect(gaps[1]).toBeGreaterThanOrEqual(1900);
  }, 90_000);

  it("leaves the same state when the same job is delivered twice", async () => {
    const record = defineJob({
      name: "test.record",
      payload,
      handle: async (data) => {
        await database().app`
          INSERT INTO public.worker_probe (id) VALUES (${data.id})
          ON CONFLICT (id) DO UPDATE SET id = excluded.id`;
      },
    });
    const { running } = await startWorker([moduleOf("a", [record])]);
    await startWorker([moduleOf("b", [record])]);

    await running.enqueue(record, { id: "dup" });
    await running.enqueue(record, { id: "dup" });
    await until(async () => (await jobRows("test.record")).filter((row) => row.state === "completed").length === 2, 20_000, "both deliveries");

    const rows = await database().app<{ id: string; runs: number }[]>`SELECT id, runs FROM public.worker_probe WHERE id = 'dup'`;
    expect(rows).toEqual([{ id: "dup", runs: 1 }]);
  });

  it("checks idempotence through the helper, and refuses a job that is not", async () => {
    const context = moduleContext(workerConfig());
    const state = async () => database().app`SELECT id, runs FROM public.worker_probe WHERE id LIKE 'helper-%' ORDER BY id`;
    const safe = defineJob({
      name: "test.helperSafe",
      payload,
      handle: async (data) => {
        await database().app`INSERT INTO public.worker_probe (id) VALUES (${`helper-${data.id}`}) ON CONFLICT DO NOTHING`;
      },
    });
    await assertIdempotent({ job: safe, payload: { id: "safe" }, context, state });

    const unsafe = defineJob({
      name: "test.helperUnsafe",
      payload,
      handle: async (data) => {
        await database().app`
          INSERT INTO public.worker_probe (id) VALUES (${`helper-${data.id}`})
          ON CONFLICT (id) DO UPDATE SET runs = worker_probe.runs + 1`;
      },
    });
    await expect(assertIdempotent({ job: unsafe, payload: { id: "unsafe" }, context, state })).rejects.toBeInstanceOf(NotIdempotentError);
  });
});

describe("shutdown", () => {
  it("lets an active job finish, then closes the pool", async () => {
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = defineJob({
      name: "test.slowFinish",
      payload,
      handle: async () => {
        entered();
        await gate;
      },
    });
    const { running, fake } = await startWorker([moduleOf("a", [slow])]);
    await running.enqueue(slow, { id: "slow" });
    await inside;

    const shutdown = running.shutdown();
    let finished = false;
    void shutdown.then(() => {
      finished = true;
    });
    await sleep(1500);
    expect(finished).toBe(false);
    expect(fake.closed.count).toBe(0);

    release();
    await shutdown;
    expect(fake.closed.count).toBe(1);
    expect((await jobRows("test.slowFinish")).map((row) => row.state)).toEqual(["completed"]);
  }, 60_000);

  it("releases a job still active at the deadline, so another worker runs it again", async () => {
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stuck = defineJob({
      name: "test.stuck",
      payload,
      retry: { limit: 1, delaySeconds: 0, backoff: false },
      handle: async () => {
        entered();
        await gate;
      },
    });
    const { running, fake } = await startWorker([moduleOf("a", [stuck])], 1000);
    await running.enqueue(stuck, { id: "stuck" });
    await inside;

    await running.shutdown();
    expect(fake.closed.count).toBe(1);
    expect((await jobRows("test.stuck")).map((row) => row.state)).not.toContain("active");

    const reruns: string[] = [];
    const again = defineJob({
      name: "test.stuck",
      payload,
      retry: { limit: 1, delaySeconds: 0, backoff: false },
      handle: (data) => {
        reruns.push(data.id);
        return Promise.resolve();
      },
    });
    await startWorker([moduleOf("b", [again])]);
    await until(() => reruns.length > 0, 20_000, "the released job to run again");
    expect(reruns).toEqual(["stuck"]);
    release();
  }, 60_000);

  it("fails the start, and closes the pool, when the pg-boss schema is not installed", async () => {
    // The last test of the file: it removes the schema the others use.
    await database().owner.unsafe(`DROP SCHEMA pgboss CASCADE`);
    const fake = fakeDatabase();
    const worker = createWorker({ config: workerConfig(), adapters: adapters(), modules: [], logger: recordingLogger(), database: fake });
    await expect(worker.start()).rejects.toThrow();
    expect(fake.closed.count).toBe(1);
  }, 60_000);
});
