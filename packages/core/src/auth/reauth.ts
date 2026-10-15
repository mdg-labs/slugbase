// The re-authentication window (doc 04 section 4.4, doc 10 T18): an operation
// that declares `reauth` needs a session whose `reauth_at` lies within the last
// ten minutes. The rule is pure; the caller passes the instant it compares with,
// so a test moves the clock.

/** How long a re-authentication counts, in milliseconds. */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

// The database stamps `reauth_at` and the application supplies `nowMs`; two hosts' clocks can differ by a few milliseconds.
const CLOCK_SKEW_MS = 5_000;

/**
 * Whether a session re-authenticated within `REAUTH_WINDOW_MS` before `nowMs`
 * (inclusive of the window's end). A stamp up to the tolerated clock difference
 * ahead of `nowMs` still counts; one further ahead, a missing one and an invalid
 * (NaN) one are stale, never fresh.
 */
export function reauthenticatedRecently(reauthAt: Date | undefined, nowMs: number): boolean {
  if (reauthAt === undefined) {
    return false;
  }
  const age = nowMs - reauthAt.getTime();
  return age >= -CLOCK_SKEW_MS && age <= REAUTH_WINDOW_MS;
}
