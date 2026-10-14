// The session model of doc 02 section 2.4, doc 04 section 4.1 and doc 01
// section 10: the cookie the browser holds and the facts a session row keeps
// about its client. The functions here are pure. The sliding window (30 days,
// 90 with "remember me"), the 180-day cap and the one-minute write interval of
// `last_seen_at` are enforced by the session system operations of
// `@slugbase/db`, on the database clock.

/** A session token is this many random bytes; only its SHA-256 is stored. */
export const SESSION_TOKEN_BYTES = 32;

/** No session outlives this many days from its creation, however it slides. */
export const SESSION_ABSOLUTE_DAYS = 180;

/** The user agent a session keeps is cut to this many characters. */
export const USER_AGENT_MAX_LENGTH = 256;

const SECONDS_PER_DAY = 24 * 60 * 60;

/** How the session cookie is named and flagged for a deployment. */
export interface SessionCookieSpec {
  readonly name: string;
  /** `__Host-slugbase_session` needs `Secure`; the plain name is used where the browser would refuse the prefix. */
  readonly secure: boolean;
  /** Seconds the browser keeps the cookie: the absolute lifetime of a session, which the server enforces more tightly. */
  readonly maxAgeSeconds: number;
}

/**
 * The cookie for the deployment origin (doc 08 section 1.3): `__Host-slugbase_session`
 * with `Secure` when `APP_ORIGIN` is https, and `slugbase_session` without it
 * when it is http. The scheme decides, not a mode flag. Anything but http and
 * https is refused rather than guessed.
 */
export function sessionCookieSpec(appOrigin: string): SessionCookieSpec {
  const maxAgeSeconds = SESSION_ABSOLUTE_DAYS * SECONDS_PER_DAY;
  if (appOrigin.startsWith("https://")) {
    return { name: "__Host-slugbase_session", secure: true, maxAgeSeconds };
  }
  if (appOrigin.startsWith("http://")) {
    return { name: "slugbase_session", secure: false, maxAgeSeconds };
  }
  throw new RangeError("the application origin must be http or https");
}

/**
 * The user agent as a session keeps it: cut to {@link USER_AGENT_MAX_LENGTH}
 * characters (code points, so a character is never split), and null when the
 * request sent none.
 */
export function truncateUserAgent(userAgent: string | null | undefined): string | null {
  if (userAgent === null || userAgent === undefined || userAgent === "") {
    return null;
  }
  const characters = Array.from(userAgent);
  return characters.length <= USER_AGENT_MAX_LENGTH ? userAgent : characters.slice(0, USER_AGENT_MAX_LENGTH).join("");
}
