import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.ts";
import { builtInJobs } from "../../src/worker/built-in.ts";
import { createWorker } from "../../src/worker/index.ts";
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
  });
});
