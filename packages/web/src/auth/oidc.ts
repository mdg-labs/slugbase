import type { ApiConfig } from "../config/config-context.tsx";
import { safeNextPath } from "./next-path.ts";

/** What an OIDC handshake is for (doc 04 section 4.5). */
export type OidcIntent = "login" | "link" | "reauth";

export const LOGIN_INTENT: OidcIntent = "login";
export const REAUTH_INTENT: OidcIntent = "reauth";

export type OidcProvider = NonNullable<ApiConfig["signIn"]>["oidc"][number];

/** The providers the operator enabled, in the order the configuration lists them; none when it lists none. */
export function oidcProvidersOf(config: ApiConfig): readonly OidcProvider[] {
  return config.signIn?.oidc ?? [];
}

/**
 * The address that starts a handshake with a provider. `returnTo` is a path of this origin, which the server checks
 * again; the slug is the one the configuration lists and is encoded into the path.
 */
export function oidcStartPath(provider: string, intent: OidcIntent, returnTo: string): string {
  const query = new URLSearchParams(intent === "login" ? {} : { intent });
  query.set("returnTo", safeNextPath(returnTo));
  return `/api/v1/auth/oidc/${encodeURIComponent(provider)}/start?${query.toString()}`;
}

/** The page the member is on, as a path to come back to after a handshake. */
export function currentReturnTo(): string {
  const { pathname, search, hash } = globalThis.location;
  return safeNextPath(`${pathname}${search}${hash}`);
}
