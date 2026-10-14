// The re-authentication window (doc 04 section 4.4, doc 10 T18): an operation
// that declares `reauth` needs a session whose `reauth_at` lies within the last
// ten minutes. The rule is pure; the caller passes the instant it compares with,
// so a test moves the clock.

/** How long a re-authentication counts, in milliseconds. */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

/**
 * Whether a session re-authenticated within `REAUTH_WINDOW_MS` before `nowMs`
 * (inclusive of the window's end). Written as "within the window", so a missing,
 * invalid (NaN) or future timestamp is stale, never fresh.
 */
export function reauthenticatedRecently(reauthAt: Date | undefined, nowMs: number): boolean {
  if (reauthAt === undefined) {
    return false;
  }
  const age = nowMs - reauthAt.getTime();
  return age >= 0 && age <= REAUTH_WINDOW_MS;
}
