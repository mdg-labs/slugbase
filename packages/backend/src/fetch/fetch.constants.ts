/** Outbound request timeout (spec §11.10, §18). */
export const FETCH_TIMEOUT_MS = 10_000;

/** Maximum response body size for egress fetches (spec §11.10). */
export const FETCH_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Metadata/favicon cache TTL - defaults-and-constants §2 (7 days). */
export const FETCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
