/**
 * The host-name lookups a process runs at once. The system resolver runs each on a libuv threadpool thread, four by
 * default and shared with password hashing, and a lookup cannot be cancelled, so a slot stays taken until its lookup
 * settles even when the request that started it has timed out. Three leaves a thread to everything else.
 */
export const PROCESS_LOOKUP_BUDGET = 3;

/** One instance's claim on a {@link LookupBudget}. */
export interface LookupShare {
  /** Takes a slot for one lookup, or returns undefined when the instance may not start another. The release is idempotent. */
  acquire(): (() => void) | undefined;
}

/** A pool of lookup slots that the egress instances of one process draw on. */
export interface LookupBudget {
  /**
   * Registers an instance that is guaranteed `reserved` slots: the slots of its reserve stay free of the other shares'
   * lookups, and it may also use any slot that no other share has reserved. Throws when the reserves of all shares
   * would exceed the budget.
   */
  share(reserved: number): LookupShare;
}

interface ShareState {
  readonly reserved: number;
  running: number;
}

/** Creates the budget that every egress instance of one process is built with. */
export function createLookupBudget(total: number = PROCESS_LOOKUP_BUDGET): LookupBudget {
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new RangeError("A lookup budget needs a positive whole number of slots");
  }
  const shares = new Set<ShareState>();
  let running = 0;

  // The slots still owed to the shares that have not used their reserve, leaving out `except`.
  const unusedReserve = (except: ShareState | undefined): number => {
    let unused = 0;
    for (const state of shares) {
      if (state !== except) {
        unused += Math.max(0, state.reserved - state.running);
      }
    }
    return unused;
  };

  return {
    share(reserved) {
      if (!Number.isSafeInteger(reserved) || reserved < 0) {
        throw new RangeError("A lookup share reserves a whole number of slots");
      }
      if (running + unusedReserve(undefined) + reserved > total) {
        throw new RangeError("The reserved lookup slots exceed the lookup budget");
      }
      const state: ShareState = { reserved, running: 0 };
      shares.add(state);
      return {
        acquire() {
          const withinReserve = state.running < state.reserved;
          if (!withinReserve && running + 1 + unusedReserve(state) > total) {
            return undefined;
          }
          state.running += 1;
          running += 1;
          let released = false;
          return () => {
            if (!released) {
              released = true;
              state.running -= 1;
              running -= 1;
            }
          };
        },
      };
    },
  };
}
