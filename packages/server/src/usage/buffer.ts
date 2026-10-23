import { USAGE_FLUSH_BATCH_SIZE, type OpenCount, type UsageStore } from "@slugbase/db";
import type { BookmarkUsage } from "@slugbase/core";
import type { Logger } from "../create-server.ts";

// The usage buffer (doc 01 section 8.1, doc 02 section 5.5, doc 05 section 3.3, doc 10 section 5 residual 1, Q28). An open is
// counted in this process's memory and nothing else: one count and the latest time per bookmark, no history, referrer or address.
// A timer of this process writes the buffer to the database every `FLUSH_INTERVAL_MS`, through the system operation
// `sys_flush_open_counts` in one call, and a graceful shutdown writes it a last time. The buffer is per process, so a
// cluster-singleton schedule could not read it. A process that dies without flushing loses what it buffered since the last flush, at
// most one interval of counts, which the threat model accepts.
//
// A flush that fails keeps its counts in the buffer for the next one, so a database that is away for a while loses nothing; the
// buffer holds one entry per bookmark that was opened, and a bookmark gets there only after its open passed the read access check.

/** How often the buffer is written to the database (doc 01 section 8.1). */
export const FLUSH_INTERVAL_MS = 10_000;

export interface UsageBuffer extends BookmarkUsage {
  /** Writes what is buffered. Rejects when the database could not take it; what it could not write stays buffered. */
  flush(): Promise<void>;
  /** Starts the timer that flushes every interval. Calling it again does nothing. */
  start(): void;
  /** Stops the timer, flushes a last time and ends the store. A failure of that last flush is logged: the shutdown goes on. Calling it again returns the same stop. */
  stop(): Promise<void>;
}

export interface UsageBufferOptions {
  readonly store: UsageStore;
  readonly logger: Pick<Logger, "warn" | "error">;
  /** The milliseconds between flushes; by default 10 s. A test passes a shorter one. */
  readonly intervalMs?: number;
  /** The clock an open is stamped with; by default the system clock. */
  readonly now?: () => Date;
}

interface Entry {
  count: number;
  lastOpenedAt: number;
}

export function createUsageBuffer({ store, logger, intervalMs = FLUSH_INTERVAL_MS, now = () => new Date() }: UsageBufferOptions): UsageBuffer {
  let entries = new Map<string, Entry>();
  let timer: NodeJS.Timeout | undefined;
  let flushing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  function keep(bookmarkId: string, count: number, lastOpenedAt: number): void {
    const held = entries.get(bookmarkId);
    if (held === undefined) {
      entries.set(bookmarkId, { count, lastOpenedAt });
    } else {
      held.count += count;
      held.lastOpenedAt = Math.max(held.lastOpenedAt, lastOpenedAt);
    }
  }

  async function writeOut(): Promise<void> {
    const taken = [...entries].map(([bookmarkId, entry]): OpenCount => ({ bookmarkId, count: entry.count, lastOpenedAt: new Date(entry.lastOpenedAt) }));
    entries = new Map();
    for (let start = 0; start < taken.length; start += USAGE_FLUSH_BATCH_SIZE) {
      try {
        await store.flush(taken.slice(start, start + USAGE_FLUSH_BATCH_SIZE));
      } catch (error) {
        for (const open of taken.slice(start)) {
          keep(open.bookmarkId, open.count, open.lastOpenedAt.getTime());
        }
        throw error;
      }
    }
  }

  function flush(): Promise<void> {
    flushing ??= writeOut().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }

  function flushQuietly(): Promise<void> {
    return flush().catch((error: unknown) => {
      logger.warn("The usage counts could not be written; they are kept for the next flush", { error: error instanceof Error ? error.name : typeof error });
    });
  }

  return {
    record(bookmarkId) {
      if (stopping === undefined) {
        keep(bookmarkId, 1, now().getTime());
      }
    },
    flush,
    start() {
      if (timer !== undefined || stopping !== undefined) {
        return;
      }
      timer = setInterval(() => void flushQuietly(), intervalMs);
      timer.unref();
    },
    stop() {
      stopping ??= (async () => {
        clearInterval(timer);
        timer = undefined;
        await flushing?.catch(() => undefined);
        try {
          await flush();
        } catch (error) {
          logger.error("The usage counts could not be written at shutdown; they are lost", { error: error instanceof Error ? error.name : typeof error });
        }
        await store.close();
      })();
      return stopping;
    },
  };
}
