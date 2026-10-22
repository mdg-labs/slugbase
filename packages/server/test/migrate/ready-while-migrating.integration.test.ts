import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type RunningServer } from "../../src/create-server.ts";
import { adapters, fakeAuthStore, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// /ready stays 503 for as long as the server's own migration runs, even when the
// database already reports the level of the build: the pg-boss schema, which
// the level does not count, may still be going in.

const migration = vi.hoisted(() => ({ finish: undefined as undefined | (() => void) }));

vi.mock("../../src/migrate/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/migrate/index.ts")>();
  return {
    ...actual,
    runMigrations: vi.fn(
      () =>
        new Promise<{ applied: [] }>((resolve) => {
          migration.finish = () => {
            resolve({ applied: [] });
          };
        }),
    ),
  };
});

vi.mock("@slugbase/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slugbase/db")>();
  return { ...actual, migrationLevel: vi.fn(() => Promise.resolve({ expected: 2, applied: 2, unknownApplied: 0 })) };
});

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.shutdown()));
});

describe("GET /ready while the server migrates", () => {
  it("answers 503 until the migration finishes, then 200 at the level of the build", async () => {
    const server = createServer({
      config: serverConfig({ NODE_ENV: "test", MIGRATE_ON_START: "true" }),
      adapters: adapters(),
      modules: [],
      migrations: [],
      logger: recordingLogger(),
      database: fakeDatabase(),
      authStore: fakeAuthStore(),
    });
    const starting = server.start({ port: 0 }).then((handle) => {
      running.push(handle);
    });
    await expect.poll(() => migration.finish !== undefined).toBe(true);

    const during = await server.fetch(new Request("http://localhost/ready"));
    expect(during.status).toBe(503);
    expect(await during.json()).toEqual({ database: "ok", migrations: { expected: 2, applied: 2 } });

    migration.finish?.();
    await starting;
    expect((await server.fetch(new Request("http://localhost/ready"))).status).toBe(200);
  });
});
