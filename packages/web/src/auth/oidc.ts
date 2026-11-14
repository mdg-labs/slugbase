import type { ApiConfig } from "../config/config-context.tsx";
import type { AcknowledgementEntries } from "./acknowledgement-checks.tsx";
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
 * What the person ticked, as the `acknowledgements` parameter of a start: the JSON text of the list a registration
 * request carries (doc 04 section 4.5). Nothing is added for no entries.
 */
function addAcknowledgements(query: URLSearchParams, acknowledgements: AcknowledgementEntries | undefined): void {
  if (acknowledgements !== undefined && acknowledgements.length > 0) {
    query.set("acknowledgements", JSON.stringify(acknowledgements));
  }
}

/**
 * The address that starts a handshake with a provider. `returnTo` is a path of this origin, which the server checks
 * again; the slug is the one the configuration lists and is encoded into the path. The acknowledgements the
 * app's extensions declare travel with a `login`, which may create an account, and with no other intent: the server
 * refuses them for a link or a re-authentication.
 */
export function oidcStartPath(provider: string, intent: OidcIntent, returnTo: string, acknowledgements?: AcknowledgementEntries): string {
  const query = new URLSearchParams(intent === "login" ? {} : { intent });
  query.set("returnTo", returnPathOf(returnTo));
  if (intent === "login") {
    addAcknowledgements(query, acknowledgements);
  }
  return `/api/v1/auth/oidc/${encodeURIComponent(provider)}/start?${query.toString()}`;
}

/**
 * The address that starts a handshake which accepts an invitation (doc 04 section 4.5). The token travels in the
 * `invitation` parameter and nowhere else: not in a `returnTo`, which the server does not read for this intent, and not
 * in the page's address once the browser has left it, since the invitation page sends no referrer. The handshake ends
 * on Home, where the workspace joined is the active one.
 */
export function oidcInvitationStartPath(provider: string, token: string, acknowledgements?: AcknowledgementEntries): string {
  const query = new URLSearchParams({ intent: "invite", invitation: token });
  addAcknowledgements(query, acknowledgements);
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
