import { useTestDatabase } from "@slugbase/testing/db";
import { getConstructionPlans } from "pg-boss";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config/index.ts";
import type { ServerModule } from "../../src/create-server.ts";
import { createWorker, defineJob, defineSchedule } from "../../src/worker/index.ts";
import type { RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { adapters, fakeDatabase, recordingLogger } from "../support.ts";

// The worker connects with the same DATABASE_URL as the server, so it refuses the
// same roles at start (Q56, doc 05 section 3.1, T1): a superuser or the owner of the
// database is not held by row-level security.

const database = useTestDatabase();

const guarded = defineJob({ name: "test.guarded", payload: z.object({}), handle: () => Promise.resolve() });
const guardedSchedule = defineSchedule({ name: "test.guardedEveryMinute", cron: "* * * * *", job: "test.guarded" });
const modules: ServerModule[] = [{ name: "guarded", register: () => ({ jobs: [guarded], schedules: [guardedSchedule] }) }];

function urlWith(login: { username: string; password: string }, port?: string): string {
  const { options } = database().app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = port ?? String(options.port[0]);
  url.username = login.username;
  url.password = login.password;
  url.pathname = `/${options.database}`;
  return url.href;
}

// The superuser of the test cluster stands for the owner of the tables: row-level security does not apply to it.
function superuserLogin(): { username: string; password: string } {
  const server = new URL(process.env["SLUGBASE_TEST_PG_URL"] ?? "postgres://slugbase:slugbase@127.0.0.1:54329/slugbase_dev");
  return { username: decodeURIComponent(server.username), password: decodeURIComponent(server.password) };
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

function worker(env: Record<string, string | undefined>) {
  const logger = recordingLogger();
  const fake = fakeDatabase();
  const created = createWorker({
    config: loadConfig("worker", productionEnv({ DATABASE_URL: urlWith(superuserLogin()), ...env })).config,
    adapters: adapters(),
    modules,
    logger,
    database: fake,
    pollingIntervalSeconds: 0.5,
  });
  return { created, logger, fake };
}

async function registered(): Promise<{ queues: number; schedules: number }> {
  const [queues] = await database().owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.queue WHERE name = ${guarded.name}`;
  const [schedules] = await database().owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.schedule WHERE name = ${guarded.name}`;
  return { queues: queues?.n ?? -1, schedules: schedules?.n ?? -1 };
}

describe("a worker whose DATABASE_URL role is not held by row-level security", () => {
  it("refuses to start in production, explaining the two roles, before any queue or schedule exists", async () => {
    const { created, logger, fake } = worker({});
    const failure = await created.start().then(
      (running) => {
        started.push(running);
        return undefined;
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("is a superuser");
    expect(message).toContain("slugbase_app");
    expect(message).toContain("slugbase_migrator");
    expect(message).toContain("SLUGBASE_ALLOW_OWNER_CONNECTION");
    expect(message).not.toMatch(/postgresql?:\/\//);
    expect(logger.entries.map((entry) => entry.message)).not.toContain("Worker started");
    expect(await registered()).toEqual({ queues: 0, schedules: 0 });
    expect(fake.closed.count).toBe(1);
  });

  it("starts with SLUGBASE_ALLOW_OWNER_CONNECTION=true, and warns", async () => {
    const { created, logger } = worker({ SLUGBASE_ALLOW_OWNER_CONNECTION: "true" });
    started.push(await created.start());
    const warnings = logger.entries.filter((entry) => entry.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("SLUGBASE_ALLOW_OWNER_CONNECTION");
    expect(warnings[0]?.fields).toMatchObject({ superuser: true });
    expect(JSON.stringify(warnings)).not.toMatch(/postgresql?:\/\//);
    expect(await registered()).toEqual({ queues: 1, schedules: 1 });
  });

  it("is not checked outside production", async () => {
    const { created, logger } = worker({ NODE_ENV: "test" });
    started.push(await created.start());
    expect(logger.entries.filter((entry) => entry.level === "warn")).toEqual([]);
  });

  it("refuses when the role cannot be read at all, whatever the override says", async () => {
    const { created, logger, fake } = worker({ DATABASE_URL: urlWith(superuserLogin(), "1"), SLUGBASE_ALLOW_OWNER_CONNECTION: "true" });
    const failure = await created.start().then(
      (running) => {
        started.push(running);
        return undefined;
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(logger.entries.map((entry) => entry.message)).not.toContain("Worker started");
    expect(fake.closed.count).toBe(1);
  });
});
