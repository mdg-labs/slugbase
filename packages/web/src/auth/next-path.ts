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
