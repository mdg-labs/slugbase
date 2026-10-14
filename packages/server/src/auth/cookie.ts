import type { SessionCookieSpec } from "@slugbase/core";

// The session cookie on the wire (doc 04 section 4.1, doc 08 section 1.3). It
// is host-only: no Domain attribute, Path=/, HttpOnly and SameSite=Lax, and
// Secure with the __Host- prefix when the deployment is served over https.

/** The value of the cookie `name` in a `Cookie` header, or undefined; the first one wins when it is repeated. */
export function readCookie(header: string, name: string): string | undefined {
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function attributes(spec: SessionCookieSpec, maxAge: number): string {
  return `Max-Age=${String(maxAge)}; Path=/; HttpOnly; SameSite=Lax${spec.secure ? "; Secure" : ""}`;
}

/** The `Set-Cookie` header that gives the browser a session token. */
export function setSessionCookie(spec: SessionCookieSpec, token: string): string {
  return `${spec.name}=${token}; ${attributes(spec, spec.maxAgeSeconds)}`;
}

/** The `Set-Cookie` header that makes the browser drop the session cookie. */
export function clearSessionCookie(spec: SessionCookieSpec): string {
  return `${spec.name}=; ${attributes(spec, 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
