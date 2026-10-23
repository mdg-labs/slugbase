import type { OpenCount, UsageStore } from "@slugbase/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLUSH_INTERVAL_MS, createUsageBuffer } from "../../src/usage/buffer.ts";

// The usage buffer (doc 01 section 8.1, doc 10 section 5 residual 1, Q28): opens are counted in memory, one count and the latest time
// per bookmark, and a timer of the process writes them. A flush that fails keeps them; a process that dies loses what it held.

const A = "0192f3a0-aaaa-7000-8000-000000000001";
const B = "0192f3a0-aaaa-7000-8000-000000000002";

interface Fixture {
  readonly store: UsageStore;
  readonly flushes: OpenCount[][];
  readonly closed: () => number;
  fail: boolean;
  clock: number;
}

function fixture(): Fixture {
  const flushes: OpenCount[][] = [];
  let closes = 0;
  const state: Fixture = {
    flushes,
    closed: () => closes,
    fail: false,
    clock: Date.parse("2026-03-01T10:00:00Z"),
    store: {
      flush(opens) {
        if (state.fail) {
          return Promise.reject(new Error("the database is away"));
        }
        flushes.push([...opens]);
        return Promise.resolve();
      },
      close() {
        closes += 1;
        return Promise.resolve();
      },
    },
  };
  return state;
}

function logs() {
  const lines: { level: string; message: string; fields?: Readonly<Record<string, unknown>> }[] = [];
  return {
    lines,
    logger: {
      warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void lines.push({ level: "warn", message, ...(fields === undefined ? {} : { fields }) }),
      error: (message: string, fields?: Readonly<Record<string, unknown>>) => void lines.push({ level: "error", message, ...(fields === undefined ? {} : { fields }) }),
    },
  };
}

function bufferOf(state: Fixture, logger = logs().logger) {
  return createUsageBuffer({ store: state.store, logger, now: () => new Date(state.clock) });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the usage buffer", () => {
  it("keeps a count and the latest time per bookmark and nothing else", async () => {
    const state = fixture();
    const buffer = bufferOf(state);

    buffer.record(A);
    state.clock += 5_000;
    buffer.record(A);
    state.clock += 2_000;
    buffer.record(B);
    state.clock -= 3_000;
    buffer.record(A);
    await buffer.flush();

    expect(state.flushes).toEqual([
      [
        { bookmarkId: A, count: 3, lastOpenedAt: new Date("2026-03-01T10:00:05Z") },
        { bookmarkId: B, count: 1, lastOpenedAt: new Date("2026-03-01T10:00:07Z") },
      ],
    ]);
    for (const open of state.flushes[0] ?? []) {
      expect(Object.keys(open).sort()).toEqual(["bookmarkId", "count", "lastOpenedAt"]);
    }
  });

  it("writes nothing for an empty buffer and empties it with each flush", async () => {
    const state = fixture();
    const buffer = bufferOf(state);

    await buffer.flush();
    buffer.record(A);
    await buffer.flush();
    await buffer.flush();

    expect(state.flushes.map((flush) => flush.length)).toEqual([1]);
  });

  it("flushes on its own every ten seconds once started, and not before", async () => {
    const state = fixture();
    const buffer = bufferOf(state);
    buffer.record(A);

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 3);
    expect(state.flushes).toEqual([]);

    buffer.start();
    buffer.start();
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS - 1);
    expect(state.flushes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.flushes).toHaveLength(1);

    buffer.record(B);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(state.flushes.map((flush) => flush.map((open) => open.bookmarkId))).toEqual([[A], [B]]);
    await buffer.stop();
  });

  it("loses at most the opens of one interval when the process dies without a flush", async () => {
    const state = fixture();
    const buffer = bufferOf(state);
    buffer.start();

    buffer.record(A);
    buffer.record(A);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    buffer.record(A);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS - 1);

    // The process is gone here: neither flush nor stop runs. What reached the store is every open but the last interval's.
    const written = state.flushes.flat().reduce((sum, open) => sum + open.count, 0);
    expect(written).toBe(2);
  });

  it("keeps what a failed flush could not write for the next one, and logs the failure without a count or an identifier", async () => {
    const state = fixture();
    const { lines, logger } = logs();
    const buffer = bufferOf(state, logger);
    buffer.start();
    buffer.record(A);
    state.fail = true;

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    buffer.record(A);
    state.clock += 1_000;
    buffer.record(B);
    state.fail = false;
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(state.flushes).toEqual([
      [
        { bookmarkId: A, count: 2, lastOpenedAt: new Date("2026-03-01T10:00:00Z") },
        { bookmarkId: B, count: 1, lastOpenedAt: new Date("2026-03-01T10:00:01Z") },
      ],
    ]);
    expect(lines).toEqual([{ level: "warn", message: "The usage counts could not be written; they are kept for the next flush", fields: { error: "Error" } }]);
    await buffer.stop();
  });

  it("rejects a flush that failed, so a caller that asked for one is told", async () => {
    const state = fixture();
    const buffer = bufferOf(state);
    buffer.record(A);
    state.fail = true;

    await expect(buffer.flush()).rejects.toThrow("the database is away");
    state.fail = false;
    await buffer.flush();

    expect(state.flushes.flat()).toEqual([{ bookmarkId: A, count: 1, lastOpenedAt: new Date(state.clock) }]);
  });

  it("does not start a second flush while one is running, and counts what arrives meanwhile in the next", async () => {
    const state = fixture();
    let release: () => void = () => undefined;
    const inFlight: OpenCount[][] = [];
    const slow: UsageStore = {
      flush: (opens) => {
        inFlight.push([...opens]);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      close: () => Promise.resolve(),
    };
    const buffer = createUsageBuffer({ store: slow, logger: logs().logger, now: () => new Date(state.clock) });
    buffer.record(A);

    const first = buffer.flush();
    const second = buffer.flush();
    buffer.record(B);
    expect(inFlight).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    const third = buffer.flush();
    expect(inFlight.map((flush) => flush.map((open) => open.bookmarkId))).toEqual([[A], [B]]);
    release();
    await third;
  });

  it("flushes a last time when stopped, ends the store, ignores later opens and returns the same stop", async () => {
    const state = fixture();
    const buffer = bufferOf(state);
    buffer.start();
    buffer.record(A);

    const first = buffer.stop();
    const second = buffer.stop();
    buffer.record(B);
    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 2);

    expect(first).toBe(second);
    expect(state.flushes.map((flush) => flush.map((open) => open.bookmarkId))).toEqual([[A]]);
    expect(state.closed()).toBe(1);
  });

  it("still ends the store, and logs the loss, when the last flush fails", async () => {
    const state = fixture();
    const { lines, logger } = logs();
    const buffer = bufferOf(state, logger);
    buffer.record(A);
    state.fail = true;

    await buffer.stop();

    expect(state.closed()).toBe(1);
    expect(lines).toEqual([{ level: "error", message: "The usage counts could not be written at shutdown; they are lost", fields: { error: "Error" } }]);
  });

  it("writes more bookmarks than one call takes in several calls, and keeps the calls that did not happen when one fails", async () => {
    const calls: number[] = [];
    let failOnCall = 2;
    const store: UsageStore = {
      flush: (opens) => {
        calls.push(opens.length);
        return calls.length === failOnCall ? Promise.reject(new Error("the database is away")) : Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const buffer = createUsageBuffer({ store, logger: logs().logger });
    for (let index = 0; index < 25_000; index += 1) {
      buffer.record(`0192f3a0-aaaa-7000-8000-${index.toString(16).padStart(12, "0")}`);
    }

    await expect(buffer.flush()).rejects.toThrow("the database is away");
    failOnCall = 0;
    await buffer.flush();

    // 10 000 written, 10 000 failed, 5 000 never sent: the next flush sends the 15 000 that were not written, in two calls.
    expect(calls).toEqual([10_000, 10_000, 10_000, 5_000]);
  });
});
