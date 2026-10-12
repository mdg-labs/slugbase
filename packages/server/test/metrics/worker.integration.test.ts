import { useTestDatabase } from "@slugbase/testing/db";
import { getConstructionPlans } from "pg-boss";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config/index.ts";
import type { ServerModule } from "../../src/create-server.ts";
import { createWorker, defineJob } from "../../src/worker/index.ts";
import type { RunningWorker } from "../../src/worker/index.ts";
import { productionEnv } from "../config/support.ts";
import { adapters, fakeDatabase, recordingLogger } from "../support.ts";
import { get, sample } from "./support.ts";

// The worker's internal metrics listener on a migrated database (doc 01
// section 3, section 12): the job queues are read from pg-boss at each scrape.

const database = useTestDatabase();

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
  const session = await database().owner.reserve();
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

const payload = z.object({ id: z.string() });

function worker(modules: ServerModule[], env: Record<string, string | undefined> = {}) {
  const config = loadConfig("worker", { ...productionEnv(env), NODE_ENV: "test", DATABASE_URL: appUrl() }).config;
  return createWorker({
    config,
    adapters: adapters(),
    modules,
    logger: recordingLogger(),
    database: fakeDatabase(),
    pollingIntervalSeconds: 0.5,
  });
}

describe("the worker's metrics listener", () => {
  it("serves the job queues of its modules next to the process metrics", async () => {
    const idle = defineJob({ name: "test.metricsIdle", payload, handle: () => Promise.resolve() });
    const other = defineJob({ name: "test.metricsOther", payload, handle: () => Promise.resolve() });
    const running = await worker([{ name: "jobs", register: () => ({ jobs: [idle, other] }) }]).start({ metricsPort: 0 });
    started.push(running);
    expect(running.metricsPort).toBeDefined();

    const response = await get(running.metricsPort ?? 0, "/metrics");
    expect(response.status).toBe(200);
    for (const queue of ["test.metricsIdle", "test.metricsOther"]) {
      for (const state of ["deferred", "ready", "active"]) {
        expect(sample(response.body, "slugbase_job_queue_depth", { queue, state }), `${queue} ${state}`).toBe(0);
      }
    }
    expect(response.body).toContain("# TYPE slugbase_job_queue_oldest_ready_age_seconds gauge");
    expect(response.body).toContain("# TYPE slugbase_db_tenant_transactions_in_flight gauge");
    expect(response.body).not.toContain("slugbase_http_requests_total{");
  });

  it("counts a job that is running", async () => {
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const running$ = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold = defineJob({
      name: "test.metricsHold",
      payload,
      handle: async () => {
        entered();
        await held;
      },
    });
    const running = await worker([{ name: "jobs", register: () => ({ jobs: [hold] }) }]).start({ metricsPort: 0 });
    started.push(running);

    await running.enqueue(hold, { id: "one" });
    await running$;
    const response = await get(running.metricsPort ?? 0, "/metrics");
    release();
    expect(sample(response.body, "slugbase_job_queue_depth", { queue: "test.metricsHold", state: "active" })).toBe(1);
  }, 30_000);

  it("opens no listener while METRICS_PORT is unset", async () => {
    const running = await worker([]).start();
    started.push(running);
    expect(running.metricsPort).toBeUndefined();
  });
});
