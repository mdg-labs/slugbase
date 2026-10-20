import type { ApiConfig } from "../config/config-context.tsx";
import { HOME_PATH, safeNextPath } from "./next-path.ts";

/** What an OIDC handshake is for (doc 04 section 4.5). */
export type OidcIntent = "login" | "link" | "reauth";

export const LOGIN_INTENT: OidcIntent = "login";
export const REAUTH_INTENT: OidcIntent = "reauth";

/** The `error` code the OIDC callback redirects with when a handshake fails (doc 04 section 4.5). */
export const OIDC_FAILED = "oidc_failed";

export type OidcProvider = NonNullable<ApiConfig["signIn"]>["oidc"][number];

/** The providers the operator enabled, in the order the configuration lists them; none when it lists none. */
export function oidcProvidersOf(config: ApiConfig): readonly OidcProvider[] {
  return config.signIn?.oidc ?? [];
}

/** An invitation link carries its token in the path; the token goes only to the two invitation operations. */
const INVITATION_PATH = /^\/invite(?![a-z0-9_-])/i;

/**
 * The page a handshake comes back to: a path of this origin, and never an invitation link, whose token must not
 * reach a handshake record. A member who started on one comes back home.
 */
function returnPathOf(value: string): string {
  const path = safeNextPath(value);
  return INVITATION_PATH.test(path) ? HOME_PATH : path;
}

/**
 * The address that starts a handshake with a provider. `returnTo` is a path of this origin, which the server checks
 * again; the slug is the one the configuration lists and is encoded into the path.
 */
export function oidcStartPath(provider: string, intent: OidcIntent, returnTo: string): string {
  const query = new URLSearchParams(intent === "login" ? {} : { intent });
  query.set("returnTo", returnPathOf(returnTo));
  return `/api/v1/auth/oidc/${encodeURIComponent(provider)}/start?${query.toString()}`;
}

/** The page the member is on, as a path to come back to after a handshake. A failure notice of an earlier handshake is not carried along. */
export function currentReturnTo(): string {
  const { pathname, search, hash } = globalThis.location;
  const query = new URLSearchParams(search);
  if (query.get("error") === OIDC_FAILED) {
    query.delete("error");
  }
  const rest = query.toString();
  return returnPathOf(`${pathname}${rest === "" ? "" : `?${rest}`}${hash}`);
}
