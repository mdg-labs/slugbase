import { redirectDocument } from "react-router";

/** Reads session cookie from an API response (undici getSetCookie or fetch get). */
export function readApiSessionCookie(res: Response): string | null {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie()[0] ?? null;
  }
  return res.headers.get("set-cookie");
}

/** Forwards the upstream session Set-Cookie onto a React Router redirect response. */
export function applyApiSessionCookie(
  response: Response,
  upstream: Response,
): void {
  const setCookie = readApiSessionCookie(upstream);
  if (setCookie !== null) {
    response.headers.set("Set-Cookie", setCookie);
  }
}

/** Secure flag for auth Set-Cookie — mirrors backend cookieSecure() in e2e. */
export function authCookieSecure(): boolean {
  if (typeof process !== "undefined" && process.env["SLUGBASE_E2E_MODE"] === "true") {
    return false;
  }
  return import.meta.env.PROD;
}

/** Redirect after an HTML form POST — full document navigation (not client-only). */
export function redirectAfterFormPost(url: string): Response {
  return redirectDocument(url, 303);
}
