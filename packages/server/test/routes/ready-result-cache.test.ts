import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READY_CACHE_TTL_MS } from "../../src/routes/health.ts";
import { adapters, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// /ready is public and not rate-limited. A finished answer is reused for a short
// time, so the work per second is bounded however fast probes arrive, and the
// journals the failure answer counts are read once per process.

interface Level {
  expected: number;
  applied: number;
  unknownApplied: number;
}

const journalReads = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]).endsWith("_journal.json")) {
        journalReads.count += 1;
      }
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

vi.mock("@slugbase/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slugbase/db")>();
  return { ...actual, migrationLevel: vi.fn() };
});

const { migrationLevel } = await import("@slugbase/db");

// Each test composes the server from a fresh module graph, so the journals the
// failure answer counts have not been read yet.
let createServer: typeof import("../../src/create-server.ts").createServer;
const READY: Level = { expected: 1, applied: 1, unknownApplied: 0 };
const BEHIND: Level = { expected: 2, applied: 1, unknownApplied: 0 };

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

async function probes(server: ReturnType<typeof start>, count: number) {
  const statuses: number[] = [];
  for (let index = 0; index < count; index += 1) {
    statuses.push((await ready(server)).status);
  }
  return statuses;
}

beforeEach(async () => {
  vi.resetModules();
  ({ createServer } = await import("../../src/create-server.ts"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T08:00:00Z"));
  vi.mocked(migrationLevel).mockReset();
  journalReads.count = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /ready result cache", () => {
  it("reads the migration level once for sequential probes inside the window", async () => {
    vi.mocked(migrationLevel).mockResolvedValue(READY);
    const server = start();
    expect(await probes(server, 25)).toEqual(Array.from({ length: 25 }, () => 200));
    vi.advanceTimersByTime(READY_CACHE_TTL_MS - 1);
    expect((await ready(server)).status).toBe(200);
    expect(migrationLevel).toHaveBeenCalledTimes(1);
  });

  it("reads again once the window has passed, so a database that fell behind reads not ready", async () => {
    vi.mocked(migrationLevel).mockResolvedValueOnce(READY).mockResolvedValueOnce(BEHIND);
    const server = start();
    expect((await ready(server)).status).toBe(200);
    vi.advanceTimersByTime(READY_CACHE_TTL_MS);
    const response = await ready(server);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ database: "ok", migrations: { expected: 2, applied: 1 } });
    expect(migrationLevel).toHaveBeenCalledTimes(2);
  });

  it("reuses a failed read inside the window and retries after it, without keeping the failure", async () => {
    vi.mocked(migrationLevel).mockRejectedValueOnce(new Error("connection refused")).mockResolvedValue(READY);
    const server = start();
    expect(await probes(server, 10)).toEqual(Array.from({ length: 10 }, () => 503));
    expect(migrationLevel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(READY_CACHE_TTL_MS);
    expect((await ready(server)).status).toBe(200);
    expect(migrationLevel).toHaveBeenCalledTimes(2);
  });

  it("counts the shipped journals once for failed probes, inside and after the window", async () => {
    vi.mocked(migrationLevel).mockRejectedValue(new Error("connection refused"));
    const server = start();
    await ready(server);
    const afterFirst = journalReads.count;
    expect(afterFirst).toBe(1);
    await probes(server, 5);
    vi.advanceTimersByTime(READY_CACHE_TTL_MS);
    await probes(server, 5);
    expect(migrationLevel).toHaveBeenCalledTimes(2);
    expect(journalReads.count).toBe(afterFirst);
  });
});
