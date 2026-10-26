import { BOOKMARK_SLUG_PATTERN } from "@slugbase/contracts";

// Only a path of this origin is a place to go after signing in; the base is never reached by a relative path.
const PROBE_ORIGIN = "http://sign-in.invalid";

export const HOME_PATH = "/";

/**
 * Where to go after signing in, given the `next` search parameter: the value when it is a path of this
 * origin, otherwise home. An absolute URL, a `//host` or `/\host` path and a `javascript:` value are
 * ignored, and so is a path that the URL parser resolves to another origin once it strips the tabs and
 * line breaks a browser strips (doc 03 section 13).
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return HOME_PATH;
  }
  let resolved: URL;
  try {
    resolved = new URL(value, PROBE_ORIGIN);
  } catch {
    return HOME_PATH;
  }
  if (resolved.origin !== PROBE_ORIGIN) {
    return HOME_PATH;
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

// The server sends a browser it does not know to `/login?returnTo=/go/<slug>`, and to `/login/mfa?returnTo=...` while the second factor is owed (doc 04 section 9.3).
const GO_RETURN = /^\/go\/([^/?#\\]+)$/;

/**
 * The address to come back to after signing in, given the `returnTo` search parameter: the value when it is exactly `/go/<slug>` with a slug in the grammar
 * (doc 02 section 6.1), and undefined for anything else, so a return address never names another origin, another path or a dot segment (doc 10 T12).
 */
export function goReturnPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const slug = GO_RETURN.exec(value)?.[1];
  return slug !== undefined && BOOKMARK_SLUG_PATTERN.test(slug) ? value : undefined;
}

/** Whether the path is one the server answers, and so is reached by a request to the server and not by the router: `/go/<slug>` forwards with a `302`. */
export function isServerPath(path: string): boolean {
  return path === "/go" || path.startsWith("/go/");
}
