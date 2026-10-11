/**
 * Timeout, in milliseconds, for a test that starts a child process. A cold
 * `node` start plus the generator or checker it runs takes several seconds on a
 * two-core CI runner that turbo shares with other packages' suites, well past
 * vitest's 5 s default.
 */
export const SUBPROCESS_TIMEOUT_MS = 60_000;
