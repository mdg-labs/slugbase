import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer, type ServerModule } from "../../src/create-server.ts";
import { defineJob } from "../../src/worker/index.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";
import { urlOf, useMigratableDatabase } from "./support.ts";

// The queues of the jobs a deployment's modules register exist once the server's own migration at
// start has run, as after the `migrate` command (doc 05 section 5.2, doc 01 section 8.1).

const database = useMigratableDatabase();
const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.shutdown()));
});

const moduleJob = defineJob({
  name: "module.inprocess",
  payload: z.object({}),
  handle: () => Promise.resolve(),
  retry: { limit: 7, delaySeconds: 30, backoff: true, maxDelaySeconds: 600 },
});

const module: ServerModule = { name: "inprocess", register: () => ({ jobs: [moduleJob] }) };

describe("MIGRATE_ON_START=true with a module that registers a job", () => {
  it("creates the queue of the job, with the retry policy the worker applies, on an empty database", async () => {
    expect(await database().owner`SELECT to_regclass('pgboss.queue') AS present`).toEqual([{ present: null }]);

    const server = createServer({
      config: serverConfig({
        NODE_ENV: "test",
        DATABASE_URL: urlOf(database().app),
        DATABASE_MIGRATE_URL: urlOf(database().owner),
        MIGRATE_ON_START: "true",
      }),
      adapters: adapters(),
      modules: [module],
      migrations: [],
      logger: recordingLogger(),
      database: fakeDatabase(),
    });
    running.push(await server.start({ port: 0 }));

    const queues = await database().owner<
      { name: string; retry_limit: number; retry_delay: number; retry_backoff: boolean; retry_delay_max: number | null }[]
    >`SELECT name, retry_limit, retry_delay, retry_backoff, retry_delay_max FROM pgboss.queue WHERE name IN ('module.inprocess', 'mail.send') ORDER BY name`;
    expect(queues).toEqual([
      { name: "mail.send", retry_limit: 3, retry_delay: 10, retry_backoff: true, retry_delay_max: null },
      { name: "module.inprocess", retry_limit: 7, retry_delay: 30, retry_backoff: true, retry_delay_max: 600 },
    ]);
  });
});
