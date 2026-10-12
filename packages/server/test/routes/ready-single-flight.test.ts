import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/create-server.ts";
import { READY_TIMEOUT_MS } from "../../src/routes/health.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// /ready is public and not rate-limited, and every migration-level read opens a
// database connection. The reads are shared, so concurrent probes, and probes that
// arrive while a timed-out read is still running, hold at most one connection.

interface Level {
  expected: number;
  applied: number;
  unknownApplied: number;
}

const reads = vi.hoisted(() => ({ pending: [] as { resolve: (level: Level) => void }[] }));

vi.mock("@slugbase/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slugbase/db")>();
  return {
    ...actual,
    migrationLevel: vi.fn(
      () =>
        new Promise<Level>((resolve) => {
          reads.pending.push({ resolve });
        }),
    ),
  };
});

const { migrationLevel } = await import("@slugbase/db");
const LEVEL: Level = { expected: 1, applied: 1, unknownApplied: 0 };

function start() {
  return createServer({
    config: serverConfig(),
    adapters: adapters(),
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
  });
}

const ready = (server: ReturnType<typeof start>) => server.fetch(new Request("http://localhost/ready"));

beforeEach(() => {
  reads.pending.length = 0;
  vi.mocked(migrationLevel).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /ready under load", () => {
  it("shares one read between concurrent probes", async () => {
    const server = start();
    const answers = Array.from({ length: 20 }, () => ready(server));
    await vi.waitFor(() => {
      expect(reads.pending).toHaveLength(1);
    });
    reads.pending[0]?.resolve(LEVEL);
    const statuses = (await Promise.all(answers)).map((response) => response.status);
    expect(statuses).toEqual(Array.from({ length: 20 }, () => 200));
    expect(migrationLevel).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh read once the shared one has settled", async () => {
    const server = start();
    const first = ready(server);
    await vi.waitFor(() => {
      expect(reads.pending).toHaveLength(1);
    });
    reads.pending[0]?.resolve(LEVEL);
    expect((await first).status).toBe(200);
    const second = ready(server);
    await vi.waitFor(() => {
      expect(reads.pending).toHaveLength(2);
    });
    reads.pending[1]?.resolve(LEVEL);
    expect((await second).status).toBe(200);
    expect(migrationLevel).toHaveBeenCalledTimes(2);
  });

  it("opens no second read while a timed-out one is still running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = start();
    const first = ready(server);
    await vi.waitFor(() => {
      expect(reads.pending).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect((await first).status).toBe(503);
    const second = ready(server);
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect((await second).status).toBe(503);
    expect(migrationLevel).toHaveBeenCalledTimes(1);
  });
});
