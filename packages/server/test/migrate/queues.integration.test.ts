import { MigrationError } from "@slugbase/db";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrate/index.ts";
import { builtInJobs } from "../../src/worker/built-in.ts";
import { defineJob } from "../../src/worker/index.ts";
import type { JobDefinition } from "../../src/worker/index.ts";
import { queueSettings } from "../../src/worker/queues.ts";
import { urlOf, useMigratableDatabase } from "./support.ts";

// The job queues exist once `migrate` has run (doc 05 section 5.5, doc 01 section
// 8.1): a transaction of the server that queues a job finds its queue before any
// worker has started. They are created from the job definitions the worker
// registers, with the settings it applies.

const database = useMigratableDatabase();

const migratorUrl = (): string => urlOf(database().owner);

interface QueueRow {
  name: string;
  retry_limit: number;
  retry_delay: number;
  retry_backoff: boolean;
  retry_delay_max: number | null;
  deletion_seconds: number;
  policy: string;
}

async function queues(): Promise<QueueRow[]> {
  return database().owner<QueueRow[]>`
    SELECT name, retry_limit, retry_delay, retry_backoff, retry_delay_max, deletion_seconds, policy
      FROM pgboss.queue ORDER BY name`;
}

const slow = defineJob({
  name: "module.slow",
  payload: z.object({}),
  handle: () => Promise.resolve(),
  retry: { limit: 7, delaySeconds: 30, backoff: true, maxDelaySeconds: 600 },
});

describe("the job queues after migrate", () => {
  it("holds a queue for each built-in job, with the settings the worker applies, and none before it ran", async () => {
    expect(await database().owner`SELECT to_regclass('pgboss.queue') AS present`).toEqual([{ present: null }]);

    await runMigrations({ url: migratorUrl() });

    const found = await queues();
    const jobs = builtInJobs();
    expect(found.map((queue) => queue.name)).toEqual(jobs.map((job) => job.name).sort());
    expect(found.map((queue) => queue.name)).toEqual(expect.arrayContaining(["mail.send", "rateLimit.purgeIdle", "retention.purge", "bookmark.fetchMetadata", "favicon.fetch"]));
    for (const job of jobs) {
      const settings = queueSettings(job);
      expect(found.find((queue) => queue.name === job.name)).toEqual({
        name: job.name,
        retry_limit: settings.retryLimit,
        retry_delay: settings.retryDelay,
        retry_backoff: settings.retryBackoff,
        retry_delay_max: settings.retryDelayMax ?? null,
        deletion_seconds: settings.deleteAfterSeconds,
        policy: settings.policy ?? "standard",
      });
    }
    // The values themselves, so a drift of both sides together is seen: three retries, backoff from ten seconds, finished jobs kept 30 days.
    expect(found.find((queue) => queue.name === "mail.send")).toMatchObject({
      retry_limit: 3,
      retry_delay: 10,
      retry_backoff: true,
      deletion_seconds: 30 * 24 * 60 * 60,
    });
  });

  it("gives the queue of a job that keeps one waiting job for each key the short policy of pg-boss, and every other queue the standard one", async () => {
    await runMigrations({ url: migratorUrl() });

    const found = await queues();
    expect(found.filter((queue) => queue.policy === "short").map((queue) => queue.name)).toEqual(["bookmark.fetchMetadata", "favicon.fetch"]);
    expect(found.filter((queue) => queue.policy !== "short").every((queue) => queue.policy === "standard")).toBe(true);
    expect(builtInJobs().filter((job) => job.dedupe).map((job) => job.name)).toEqual(["bookmark.fetchMetadata", "favicon.fetch"]);
  });

  it("creates the queues of the jobs it is given, with their own retry policy", async () => {
    await runMigrations({ url: migratorUrl(), jobs: [slow] });

    expect((await queues()).find((queue) => queue.name === "module.slow")).toMatchObject({
      retry_limit: 7,
      retry_delay: 30,
      retry_backoff: true,
      retry_delay_max: 600,
    });
  });

  it("leaves an existing queue as it is and the application role can read it", async () => {
    await database().owner.unsafe(`UPDATE pgboss.queue SET retry_limit = 9 WHERE name = 'mail.send'`);

    const result = await runMigrations({ url: migratorUrl(), jobs: [slow] });

    expect(result.applied).toEqual([]);
    expect((await queues()).find((queue) => queue.name === "mail.send")?.retry_limit).toBe(9);
    expect(await database().app`SELECT count(*)::int AS n FROM pgboss.queue WHERE name = 'mail.send'`).toEqual([{ n: 1 }]);
  });

  it("fails migrate, naming no password, when a queue cannot be created", async () => {
    const broken: JobDefinition = { ...slow, name: "not a queue name" };
    const url = migratorUrl();

    const failure = await runMigrations({ url, jobs: [broken] }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(MigrationError);
    expect((failure as MigrationError).message).not.toContain(url);
    expect((failure as MigrationError).message).not.toContain(String(database().owner.options.pass));
    expect((await queues()).map((queue) => queue.name)).not.toContain("not a queue name");
  });
});
