import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// The lock of the account's preferences (support/account-preferences.ts), without the Playwright imports of that file, so that a unit test can
// read it. The journeys run in parallel in several processes, so the lock is kept in files: a state file in a directory, and a short mutex
// beside it that is held only while the state is read and changed.
//
// The mutex is a token that is always in one of two places: a file `<dir>.mutex-free`, or a file `<dir>.mutex-held.<pid>.<id>` of the process
// that holds it. Taking it is one rename of the free file to a held name that only this process uses, so exactly one of the processes that
// try gets it; giving it up is the rename back. A holder whose process is gone is broken by renaming its held file, whose name no other
// holder will ever have, to the free file: a process that is late with that cannot take the mutex from a later holder, because the name it
// renames is not there any more. The global setup puts the token in place (`clearPreferencesLock`).
//
// A journey asks for the values of the preferences it needs. Journeys that ask for the same values and only read them hold the lock together,
// the first of them puts the values in place and the last one puts the previous ones back; a journey that asks for other values, or that
// may change them itself (one that sets the theme can toggle it in the page), holds it alone. The journeys wait in the order they came, and
// one that cannot enter yet keeps the later ones that would not agree with it out, so a journey that needs the lock alone is not starved by a
// stream of journeys that share it.

/** What a journey asks the account's preferences to be. */
export interface Wants {
  theme?: string;
  locale?: string;
  /** The journey acts on the workspace's own content (it counts or removes what is there), so it holds the lock alone. */
  alone?: boolean;
}

interface Entry {
  id: string;
  /** The process of the journey: a holder or a waiter whose process is gone (a worker that was stopped) is dropped. */
  pid: number;
  wants: Wants;
}

/** What the lock keeps: who holds it, who waits (first come first), and what the first holder left to restore. */
export interface LockState {
  holders: Entry[];
  queue: Entry[];
  stored: unknown;
}

/**
 * Whether two journeys may hold the lock together: both ask for the same values, neither sets the theme, and neither asks to be alone. A
 * journey that sets the theme is one that toggles it in the page or scans the page in it, so it holds the lock alone; the language is only
 * read by the others. A journey that acts on the content of the one workspace of the stack (the lock was also what kept the other journeys
 * away from it) asks to be alone.
 */
export function shares(a: Wants, b: Wants): boolean {
  return a.alone !== true && b.alone !== true && a.theme === undefined && b.theme === undefined && a.locale === b.locale;
}

/** Whether the waiting journey `id` may enter: it shares with every holder and with every journey that came before it. */
export function mayEnter(state: LockState, id: string): boolean {
  const at = state.queue.findIndex((entry) => entry.id === id);
  const waiting = state.queue[at];
  if (waiting === undefined) {
    return false;
  }
  const { wants } = waiting;
  return state.holders.every((holder) => shares(wants, holder.wants)) && state.queue.slice(0, at).every((before) => shares(wants, before.wants));
}

const STATE_FILE = "state.json";
const MUTEX_POLL_MS = 10;
/** How long a journey that is not waiting for its turn at the lock waits for the mutex, which is held for the length of a change only. */
const SHORT_WAIT_MS = 30_000;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freeMutex(dir: string): string {
  return `${dir}.mutex-free`;
}

function heldPrefix(dir: string): string {
  return `${basename(dir)}.mutex-held.`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** The state of the lock without the holders and the waiters whose process is gone; with no holder left, nothing is left to put back. */
function readState(dir: string): LockState {
  let state: LockState;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) as Partial<LockState>;
    state = { holders: parsed.holders ?? [], queue: parsed.queue ?? [], stored: parsed.stored ?? null };
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    state = { holders: [], queue: [], stored: null };
  }
  state.holders = state.holders.filter((holder) => isAlive(holder.pid));
  state.queue = state.queue.filter((waiting) => isAlive(waiting.pid));
  if (state.holders.length === 0) {
    state.stored = null;
  }
  return state;
}

function writeState(dir: string, state: LockState): void {
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `${STATE_FILE}.${randomUUID()}`);
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, join(dir, STATE_FILE));
}

/** Gives the mutex back from a process that is gone: the held file of that process becomes the free one. One that was broken already is not there, and is left alone. */
function breakGoneHolders(dir: string): void {
  const parent = dirname(dir);
  const prefix = heldPrefix(dir);
  for (const name of readdirSync(parent)) {
    if (name.startsWith(prefix) && !isAlive(Number(name.slice(prefix.length).split(".")[0]))) {
      try {
        renameSync(join(parent, name), freeMutex(dir));
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }
    }
  }
}

/**
 * Runs `change` while this process holds the mutex of the state; the mutex is taken in turn, and given back on every way out, unless it was
 * broken in the meantime (the process looked gone), in which case there is nothing of this process's to give back.
 */
export async function underMutex<T>(dir: string, deadline: number, change: () => Promise<T> | T): Promise<T> {
  const free = freeMutex(dir);
  const held = `${dir}.mutex-held.${String(process.pid)}.${randomUUID()}`;
  for (;;) {
    try {
      renameSync(free, held);
      break;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    breakGoneHolders(dir);
    if (Date.now() >= deadline) {
      throw new Error(`the state of the preferences lock stayed in use (${free}; the global setup puts it in place)`);
    }
    await pause(MUTEX_POLL_MS);
  }
  try {
    return await change();
  } finally {
    try {
      renameSync(held, free);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
}

/** Takes a journey that gave up out of the queue; one that is not in it is left alone. */
async function withdraw(dir: string, id: string, waitMs: number): Promise<void> {
  await underMutex(dir, Date.now() + waitMs, () => {
    const state = readState(dir);
    state.queue = state.queue.filter((entry) => entry.id !== id);
    writeState(dir, state);
  });
}

export interface EnterOptions {
  /** How long to wait to enter. */
  waitMs: number;
  /** How often to look again while waiting. */
  pollMs: number;
  /** Runs for the first journey of a group, with the lock held, and returns what the last one needs to put the previous values back (not null). */
  apply: () => Promise<unknown>;
}

/**
 * Waits until the journey may hold the lock with what it asks for, and returns its id. The journey that finds the lock free runs `apply`
 * before any other can enter; a journey that joins holders that share with it runs nothing, the values are in place. A wait that runs out
 * throws, and so does an `apply` that fails; the journey is then not a holder.
 */
export async function enter(dir: string, wants: Wants, options: EnterOptions): Promise<string> {
  const id = randomUUID();
  const deadline = Date.now() + options.waitMs;
  // The wait for the lock is `deadline`; the mutex is held for the length of a change only, so each look at the state waits for it briefly.
  const mutexWaitMs = Math.min(options.waitMs, SHORT_WAIT_MS);
  await underMutex(dir, Date.now() + mutexWaitMs, () => {
    const state = readState(dir);
    state.queue.push({ id, pid: process.pid, wants });
    writeState(dir, state);
  });
  try {
    for (;;) {
      const entered = await underMutex(dir, Date.now() + mutexWaitMs, async () => {
        const state = readState(dir);
        if (!mayEnter(state, id)) {
          return false;
        }
        state.queue = state.queue.filter((entry) => entry.id !== id);
        if (state.holders.length === 0) {
          try {
            state.stored = await options.apply();
          } catch (error) {
            // The journey left the queue and holds nothing.
            writeState(dir, state);
            throw error;
          }
        }
        state.holders.push({ id, pid: process.pid, wants });
        writeState(dir, state);
        return true;
      });
      if (entered) {
        return id;
      }
      if (Date.now() >= deadline) {
        throw new Error(`the preferences of the account stayed locked for ${String(options.waitMs / 1000)} seconds (${dir})`);
      }
      await pause(options.pollMs);
    }
  } catch (error) {
    await withdraw(dir, id, options.waitMs).catch(() => undefined);
    throw error;
  }
}

/**
 * Lets the journey `id` go. The last holder to go runs `restore` with what `apply` returned, with the lock still held, so that the next
 * journey finds the values back; the state is cleared before `restore` runs, so a restore that fails does not leave the lock held.
 */
export async function leave(dir: string, id: string, restore: (stored: unknown) => Promise<void>, waitMs: number = SHORT_WAIT_MS): Promise<void> {
  // A journey that cannot get the mutex would stay a holder for as long as its worker lives, so it waits as long as it was allowed to wait for the lock.
  await underMutex(dir, Date.now() + waitMs, async () => {
    const state = readState(dir);
    state.holders = state.holders.filter((holder) => holder.id !== id);
    const stored = state.stored;
    const last = state.holders.length === 0;
    if (last) {
      state.stored = null;
    }
    writeState(dir, state);
    if (last && stored !== null) {
      await restore(stored);
    }
  });
}

/** Removes the lock and the mutex that an earlier run left and puts the mutex in place, free; used by the global setup, before any journey runs. */
export function clearPreferencesLock(dir: string): void {
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  rmSync(freeMutex(dir), { force: true });
  for (const name of readdirSync(parent)) {
    if (name.startsWith(heldPrefix(dir))) {
      rmSync(join(parent, name), { force: true });
    }
  }
  writeFileSync(freeMutex(dir), "");
}
