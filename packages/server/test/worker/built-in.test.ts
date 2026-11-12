import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import { builtInJobs } from "../../src/worker/built-in.ts";
import { createWorker, defineJob, defineSchedule, monitorSlug } from "../../src/worker/index.ts";
import { z } from "zod";
import { productionEnv } from "../config/support.ts";
import { adapters, fakeDatabase, recordingLogger } from "../support.ts";

describe("the built-in jobs", () => {
  it("are the jobs a worker composes with no module, which is the list migrate creates the queues of", () => {
    const worker = createWorker({
      config: loadConfig("worker", { ...productionEnv(), NODE_ENV: "test" }).config,
      adapters: adapters(),
      modules: [],
      logger: recordingLogger(),
      database: fakeDatabase(),
    });

    expect(builtInJobs().map((job) => job.name).sort()).toEqual(worker.jobs.map((job) => job.name).sort());
    expect(builtInJobs().map((job) => job.name)).toContain("mail.send");
    expect(builtInJobs().map((job) => job.name)).toContain("bookmark.fetchMetadata");
    expect(worker.jobs.map((job) => job.name)).toContain("bookmark.fetchMetadata");
    expect(builtInJobs().map((job) => job.name)).toContain("favicon.fetch");
    expect(worker.jobs.map((job) => job.name)).toContain("favicon.fetch");
    expect(builtInJobs().map((job) => job.name)).toContain("secrets.reseal");
    expect(worker.jobs.map((job) => job.name)).toContain("secrets.reseal");
    expect(worker.schedules.map((schedule) => schedule.name)).toContain("secrets.reseal");
  });

  it("have the monitor slugs that docs/self-hosting/operations.md lists", () => {
    const worker = createWorker({
      config: loadConfig("worker", { ...productionEnv(), NODE_ENV: "test" }).config,
      adapters: adapters(),
      modules: [],
      logger: recordingLogger(),
      database: fakeDatabase(),
    });

    expect(worker.schedules.map((schedule) => monitorSlug(schedule.name)).sort()).toEqual([
      "accounts-end-access-mode",
      "rate-limit-purge-idle",
      "retention-purge",
      "secrets-reseal",
    ]);
  });

  it("warn at start, when monitored runs are reported, about a job several schedules name, which reports none", () => {
    const report = defineJob({ name: "report.send", payload: z.object({}), handle: () => Promise.resolve() });
    const module = {
      name: "reports",
      register: () => ({
        jobs: [report],
        schedules: [
          defineSchedule({ name: "report.daily", cron: "0 3 * * *", job: report.name }),
          defineSchedule({ name: "report.weekly", cron: "0 4 * * 1", job: report.name }),
        ],
      }),
    };
    const create = (withCheckIns: boolean) => {
      const logger = recordingLogger();
      const base = adapters();
      const errors = withCheckIns ? { ...base.errors, startMonitoredRun: () => Promise.resolve({ finish: () => Promise.resolve() }) } : base.errors;
      createWorker({ config: loadConfig("worker", { ...productionEnv(), NODE_ENV: "test" }).config, adapters: { ...base, errors }, modules: [module], logger, database: fakeDatabase() });
      return logger.entries.filter((entry) => entry.message === "A job several schedules name reports no monitored runs");
    };

    expect(create(true)).toEqual([{ level: "warn", message: "A job several schedules name reports no monitored runs", fields: { job: "report.send" } }]);
    expect(create(false)).toEqual([]);
  });
});
