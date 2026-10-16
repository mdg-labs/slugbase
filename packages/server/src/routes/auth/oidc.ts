import { completeOidcSignIn, startOidcSignIn } from "@slugbase/contracts";
import {
  OIDC_FAILURE_CODE,
  bindOidcState,
  hashOidcState,
  newOidcHandshake,
  oidcCodeVerifierOptions,
  oidcPreAuthCookieSpec,
  oidcStateIsBound,
  reauthenticatedRecently,
  safeReturnTo,
  truncateUserAgent,
  PortUnavailable,
  type IdentityPort,
  type OidcPreAuthCookieSpec,
  type SecretBoxPort,
  type SessionCookieSpec,
} from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { hkdfSync } from "node:crypto";
import { readCookie, setSessionCookie } from "../../auth/cookie.ts";
import { hashSessionToken, newSessionToken } from "../../auth/session-token.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";

// GET /api/v1/auth/oidc/{provider}/start and /callback (doc 04 sections 4.4, 4.5 and 10.2, doc 02 section 2.8,
// doc 10 T4, T12, T18 and T20): the authorization-code flow with PKCE, a state and a nonce, for three intents.
// `login` signs in the account an identity is already linked to. `link` adds the identity to the account of the
// signed-in session that started the handshake, and `reauth` marks that session as re-authenticated when the
// identity belongs to its account. The start stores the handshake server side and binds it to the browser with
// a short-lived pre-auth cookie; the callback consumes the record once and acts only when the identity port has
// verified the provider's ID token. `link` and `reauth` are started only by a complete session, in a request
// that a browser reports as coming from the application itself (`Sec-Fetch-Site: same-origin`, or `none` for the
// address bar; a request that names another site or no site at all is refused), and end only in a browser whose
// current session is the one of the account that started them. Linking an identity also needs a fresh
// re-authentication (doc 04 section 4.4, doc 10 T18), because a linked identity outlives a password change and the
// revocation of every session: the start answers a session that has not re-authenticated within the window
// with the `401 reauth_required` problem, the one answer the application's own page can act on, and the
// callback checks the same window again, because up to ten minutes pass between the two. `reauth` needs
// none, since it is how a session gets one. Everything that can go wrong
// ends on `/login` with the same failure code and nothing in the answer says which step refused, so the answer
// reveals neither whether an account exists nor why a handshake failed; the reason goes to the log as a fixed word.

const SUBKEY_BYTES = 32;
const FAILURE_LOCATION = `/login?error=${OIDC_FAILURE_CODE}`;
const MAX_CODE_LENGTH = 2048;

export interface OidcRoutesOptions {
  readonly store: Pick<
    AuthStore,
    "createOidcLoginState" | "consumeOidcLoginState" | "signInWithIdentity" | "linkIdentity" | "reauthenticateWithIdentity"
  >;
  readonly identity: Pick<IdentityPort, "begin" | "complete">;
  /** Seals the PKCE verifier while the handshake is in flight, and opens it at the callback. */
  readonly secretBox: Pick<SecretBoxPort, "seal" | "open">;
  /** `APP_ORIGIN`: the callback address registered with the providers, and the scheme of the cookies. */
  readonly appOrigin: string;
  /** `SESSION_SECRET`: the pre-auth cookie is a keyed hash made with a key derived from it. */
  readonly sessionSecret: string;
  readonly sessionCookie: SessionCookieSpec;
  /** The instant, in milliseconds, a session's `reauth_at` is compared with; defaults to the system clock. */
  readonly now?: () => number;
}

/** The fixed words of the log line that says why a handshake did not end in a session. */
type Refusal =
  | "provider_unavailable"
  | "provider_error"
  | "malformed_callback"
  | "foreign_browser"
  | "unknown_state"
  | "unsupported_intent"
  | "exchange_failed"
  | "invalid_token"
  | "unknown_identity"
  | "no_session"
  | "cross_site_start"
  | "session_mismatch"
  | "reauth_required"
  | "identity_in_use"
  | "unknown_account";

function preAuthAttributes(spec: OidcPreAuthCookieSpec, maxAge: number): string {
  return `Max-Age=${String(maxAge)}; Path=/; HttpOnly; SameSite=Lax${spec.secure ? "; Secure" : ""}`;
}

function setPreAuthCookie(spec: OidcPreAuthCookieSpec, binding: string): string {
  return `${spec.name}=${binding}; ${preAuthAttributes(spec, spec.maxAgeSeconds)}`;
}

function clearPreAuthCookie(spec: OidcPreAuthCookieSpec): string {
  return `${spec.name}=; ${preAuthAttributes(spec, 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

// The reason an identity port gave for refusing, when it gave one; a port that is not configured is an unavailable
// provider. Never a message.
function describeFailure(error: unknown): Refusal {
  const reason = typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined;
  if (reason === "provider_unavailable" || reason === "invalid_token") {
    return reason;
  }
  return error instanceof PortUnavailable ? "provider_unavailable" : "exchange_failed";
}

// The account of a complete session of this request: a session that is waiting for its second factor, an API token
// and no credential at all are no session here.
function signedInSession(
  context: ChainContext,
): { readonly sessionId: string; readonly accountId: string; readonly reauthAt: Date | undefined } | undefined {
  const principal = context.get("principal");
  return principal?.kind === "session" && principal.mfaPending !== true
    ? { sessionId: principal.sessionId, accountId: principal.accountId, reauthAt: principal.reauthAt }
    : undefined;
}

// A browser says where a navigation came from (Sec-Fetch-Site). Only the application's own page (`same-origin`)
// and the address bar or a bookmark (`none`) may start a link or a re-authentication. A page of another site, a
// sibling subdomain included, may not, and neither may a request that carries no such header: a browser that
// does not send it cannot show the request came from the application, so it fails closed there. Such a browser
// cannot link or re-authenticate through a provider; a sign-in through a provider (`login`) is not affected. An
// account with a password re-authenticates with it, one with a second factor and no password uses a code, and one
// with neither cannot re-authenticate on that browser.
function fromTheApplication(context: ChainContext): boolean {
  const site = context.req.raw.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}

function refused(context: ChainContext, provider: string, reason: Refusal): void {
  context.get("logger")?.warn("An OIDC sign-in ended without a session", { provider, reason });
}

export function oidcRoutes({ store, identity, secretBox, appOrigin, sessionSecret, sessionCookie, now = Date.now }: OidcRoutesOptions): RouteBinding[] {
  const preAuth = oidcPreAuthCookieSpec(appOrigin);
  const origin = new URL(appOrigin).origin;
  const bindingKey = Buffer.from(hkdfSync("sha256", sessionSecret, "", "slugbase:oidc:pre-auth", SUBKEY_BYTES));
  const redirectUriOf = (provider: string): string => `${origin}/api/v1/auth/oidc/${provider}/callback`;
  const failure = { status: 302, headers: { Location: FAILURE_LOCATION, "Set-Cookie": clearPreAuthCookie(preAuth) } } as const;

  const start = route(startOidcSignIn).handle(async ({ params, query }, context) => {
    const intent = query.intent;
    let linkAccountId: string | null = null;
    if (intent !== "login") {
      const session = signedInSession(context);
      if (session === undefined) {
        refused(context, params.provider, "no_session");
        return failure;
      }
      if (!fromTheApplication(context)) {
        refused(context, params.provider, "cross_site_start");
        return failure;
      }
      // Starting a link is the one start that answers with a problem: the member is in the application, and the
      // page needs to tell "re-authenticate first" apart from a handshake that failed.
      if (intent === "link" && !reauthenticatedRecently(session.reauthAt, now())) {
        refused(context, params.provider, "reauth_required");
        throw new ProblemError("reauth_required", "Recent re-authentication is required.");
      }
      linkAccountId = session.accountId;
    }
    const handshake = newOidcHandshake();
    let authorizationUrl: string;
    try {
      ({ authorizationUrl } = await identity.begin({
        providerId: params.provider,
        redirectUri: redirectUriOf(params.provider),
        state: handshake.state,
        nonce: handshake.nonce,
        codeChallenge: handshake.codeChallenge,
        ...(intent === "reauth" ? { reauthenticate: true } : {}),
      }));
    } catch (error) {
      refused(context, params.provider, describeFailure(error));
      return failure;
    }
    const sealed = await secretBox.seal(new TextEncoder().encode(handshake.codeVerifier), oidcCodeVerifierOptions(handshake.stateHash));
    await store.createOidcLoginState({
      stateHash: handshake.stateHash,
      provider: params.provider,
      intent,
      nonce: handshake.nonce,
      codeVerifier: sealed,
      returnTo: safeReturnTo(query.returnTo),
      linkAccountId,
    });
    return {
      status: 302,
      headers: { Location: authorizationUrl, "Set-Cookie": setPreAuthCookie(preAuth, bindOidcState(bindingKey, handshake.state)) },
    };
  });

  const callback = route(completeOidcSignIn).handle(async ({ params }, context) => {
    const fail = (reason: Refusal) => {
      refused(context, params.provider, reason);
      return failure;
    };
    // The provider's own parameters: the ones RFC 6749 names are read, whatever else it appends is ignored.
    const query = new URL(context.req.url).searchParams;
    const [state, ...otherStates] = query.getAll("state");
    const codes = query.getAll("code");
    const cookieHeader = context.req.raw.headers.get("cookie");
    const binding = cookieHeader === null ? undefined : readCookie(cookieHeader, preAuth.name);
    const stateHash = state === undefined || otherStates.length > 0 ? undefined : hashOidcState(state);
    if (state === undefined || stateHash === undefined) {
      return fail("malformed_callback");
    }
    // The browser that started the handshake is the only one that holds the cookie. A callback without it is refused
    // before the record is touched, so a state seen by someone else cannot be used up from another browser.
    if (binding === undefined || !oidcStateIsBound(bindingKey, state, binding)) {
      return fail("foreign_browser");
    }
    const record = await store.consumeOidcLoginState(stateHash, params.provider);
    if (record === undefined) {
      return fail("unknown_state");
    }
    // The invitation intent arrives with its own operation.
    if (record.intent === "invite") {
      return fail("unsupported_intent");
    }
    // A link or a re-authentication is the work of the account that started it: the browser must still hold a
    // complete session of that account, not merely the pre-auth cookie of the handshake.
    let owner: ReturnType<typeof signedInSession>;
    if (record.intent !== "login") {
      owner = signedInSession(context);
      if (owner === undefined || owner.accountId !== record.linkAccountId) {
        return fail("session_mismatch");
      }
      if (record.intent === "link" && !reauthenticatedRecently(owner.reauthAt, now())) {
        return fail("reauth_required");
      }
    }
    const code = codes[0];
    if (query.has("error") || codes.length !== 1 || code === undefined || code === "" || code.length > MAX_CODE_LENGTH) {
      return fail(query.has("error") ? "provider_error" : "malformed_callback");
    }

    const verifier = await secretBox.open(record.codeVerifier, oidcCodeVerifierOptions(stateHash));
    let claims;
    try {
      claims = await identity.complete({
        providerId: params.provider,
        redirectUri: redirectUriOf(params.provider),
        code,
        nonce: record.nonce,
        codeVerifier: new TextDecoder().decode(verifier),
      });
    } catch (error) {
      return fail(describeFailure(error));
    } finally {
      verifier.fill(0);
    }
    if (claims.providerId !== params.provider) {
      return fail("invalid_token");
    }

    if (owner !== undefined) {
      if (record.intent === "link") {
        const linked = await store.linkIdentity({
          accountId: owner.accountId,
          id: uuidv7(),
          provider: params.provider,
          subject: claims.subject,
          email: claims.email,
        });
        if (linked === "taken") {
          return fail("identity_in_use");
        }
        if (linked === "no_account") {
          return fail("unknown_account");
        }
      } else if (
        !(await store.reauthenticateWithIdentity({
          sessionId: owner.sessionId,
          accountId: owner.accountId,
          provider: params.provider,
          subject: claims.subject,
        }))
      ) {
        return fail("unknown_identity");
      }
      return { status: 302, headers: { Location: safeReturnTo(record.returnTo), "Set-Cookie": clearPreAuthCookie(preAuth) } };
    }

    const token = newSessionToken();
    const carried = cookieHeader === null ? undefined : readCookie(cookieHeader, sessionCookie.name);
    const signedIn = await store.signInWithIdentity({
      provider: params.provider,
      subject: claims.subject,
      sessionId: uuidv7(),
      ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null,
      userAgent: truncateUserAgent(context.req.raw.headers.get("user-agent")),
      tokenHash: token.hash,
      replacedTokenHash: carried === undefined ? null : (hashSessionToken(carried) ?? null),
    });
    if (!signedIn) {
      return fail("unknown_identity");
    }
    return { status: 302, headers: { Location: safeReturnTo(record.returnTo), "Set-Cookie": setSessionCookie(sessionCookie, token.value) } };
  });

  // A handler answers with one Set-Cookie. A sign-in sets the session cookie, and the pre-auth cookie ends with the
  // handshake whatever the outcome, so the second header is added to the response here.
  const cleared = clearPreAuthCookie(preAuth);
  const completing: RouteBinding = {
    ...callback,
    handler: async (context, matched) => {
      const response = await callback.handler(context, matched);
      if (!response.headers.getSetCookie().includes(cleared)) {
        response.headers.append("Set-Cookie", cleared);
      }
      return response;
    },
  };
  return [start, completing];
}
