import type postgres from "postgres";
import type { TestDatabase } from "../../src/testing.ts";
import { asSystem } from "./auth-fixture.ts";

const BLOCKED_DEADLINE_MS = 15_000;
const POLL_MS = 25;

/**
 * Runs `call` while another transaction holds an uncommitted write, and commits that transaction once `call` is waiting on it: the write the call
 * could not see when it checked is then committed under it, which is what a writer that takes none of the call's locks does. The wait is found as a
 * session of the test database waiting for another transaction to end, so nothing else may wait on one in that database meanwhile.
 * When `commit` is false the held transaction is rolled back instead. The race counts as exercised only when that wait was seen within `deadlineMs`: a call that
 * finishes first, or is still running unseen waiting when the deadline passes, fails the test, so a call delayed by load cannot pass by finding the write committed.
 */
export async function withUncommittedWrite<T>(
  database: TestDatabase,
  write: (tx: postgres.TransactionSql) => Promise<unknown>,
  call: () => Promise<T>,
  options: { commit?: boolean; deadlineMs?: number } = {},
): Promise<T> {
  let held = (): void => undefined;
  let written = (): void => undefined;
  const writtenSignal = new Promise<void>((resolve) => {
    written = resolve;
  });
  const holder = asSystem(database, async (tx) => {
    await write(tx);
    written();
    await new Promise<void>((resolve) => {
      held = resolve;
    });
    if (options.commit === false) {
      throw new RollbackRequested();
    }
  }).catch((error: unknown) => {
    if (!(error instanceof RollbackRequested)) {
      throw error;
    }
  });
  await Promise.race([writtenSignal, holder]);
  let outcome: Promise<{ readonly value: T } | { readonly error: unknown }> | undefined;
  let failure: { readonly error: unknown } | undefined;
  let exercised = false;
  let settledFirst = false;
  try {
    outcome = call().then(
      (value) => ({ value }) as const,
      (error: unknown) => ({ error }) as const,
    );
    const deadline = Date.now() + (options.deadlineMs ?? BLOCKED_DEADLINE_MS);
    const state = { settled: false };
    void outcome.then(() => {
      state.settled = true;
    });
    while (!exercised && !state.settled && Date.now() < deadline) {
      exercised = await waiting(database);
      if (!exercised) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    }
    settledFirst = state.settled;
  } catch (error) {
    failure = { error };
  }
  // The holder is released on every exit, so its write and its connection never outlive the call; an error already seen is the one reported.
  held();
  try {
    await holder;
  } catch (error) {
    failure ??= { error };
  }
  const result = outcome === undefined ? undefined : await outcome;
  if (failure !== undefined) {
    throw failure.error;
  }
  if (!exercised) {
    throw new Error(
      settledFirst
        ? "the call finished without waiting on the held write, so the test did not exercise the race"
        : "the call was not seen waiting on the held write before the deadline, so the test did not exercise the race",
    );
  }
  if (result === undefined) {
    throw new Error("the call was never started");
  }
  if ("error" in result) {
    throw result.error;
  }
  return result.value;
}

class RollbackRequested extends Error {}

async function waiting(database: TestDatabase): Promise<boolean> {
  const rows = await database.owner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE NOT l.granted AND l.locktype = 'transactionid' AND a.datname = current_database() AND a.pid <> pg_backend_pid()`;
  return (rows[0]?.n ?? 0) > 0;
}
