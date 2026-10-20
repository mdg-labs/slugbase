import { completeOidcSignIn, startOidcSignIn } from "@slugbase/contracts";
import {
  OIDC_FAILURE_CODE,
  acceptInvitationWithIdentity,
  autoCreateAllowed,
  bindOidcState,
  federatedDisplayName,
  hashCredentialToken,
  hashOidcState,
  newOidcHandshake,
  normalizeEmail,
  oidcCodeVerifierOptions,
  oidcPreAuthCookieSpec,
  oidcStateIsBound,
  reauthenticatedRecently,
  registrationLocale,
  safeReturnTo,
  truncateUserAgent,
  PortUnavailable,
  type IdentityClaims,
  type IdentityPort,
  type IdentityProviderConfig,
  type InvitationIdentityResult,
  type InvitationSignupEvent,
  type OidcPreAuthCookieSpec,
  type RegistrationSettings,
  type SecretBoxPort,
  type SessionCookieSpec,
} from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { hkdfSync } from "node:crypto";
import { readCookie, setSessionCookie } from "../../auth/cookie.ts";
import { provisionWorkspaceIn } from "../../auth/personal-workspace.ts";
import { assertRegistrationAllowed } from "../../auth/registration-gate.ts";
import { hashSessionToken, newSessionToken } from "../../auth/session-token.ts";
import type { TakeTokenRedeemLimit } from "../../auth/token-redeem-limit.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { queueDomainEvent } from "../../events/publish.ts";
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
// none, since it is how a session gets one.
// A `login` with an identity nobody has linked is a first login (doc 02 sections 2.2 and 2.8, doc 10 T17 and T20). It
// does something only when the provider asserted an address as verified: the identity is then linked to the enabled
// account that holds the address verified, and, when none does, an account is created for it if the provider allows
// that (`AUTO_CREATE`), the address passes its `ALLOWED_DOMAINS` and the registration policy of the composed modules
// (path `oidc`) allows it. An address nobody verified links nothing and creates nothing. The session is a full one,
// as for a linked identity: the provider is trusted for the second factor. Everything that can go wrong
// ends on `/login` with the same failure code and nothing in the answer says which step refused, so the answer
// reveals neither whether an account exists nor why a handshake failed; the reason goes to the log as a fixed word.
// The `invite` intent accepts an invitation through the provider (doc 02 sections 2.8 and 3.4, Q31, Q32, doc 04 section
// 4.5, doc 10 T9, T19 and T20). The start takes the invitation token in its own parameter, counts the redemption against
// the `token_redeem` limits of the client address (and of the account of a complete session the browser carries) and keeps
// only the token's hash with the handshake record, never the token and never in the `returnTo`; a text that is not a token
// ends like any failed start. The callback consumes the record once, and accepts only when the identity port has verified
// the ID token and the provider asserted `email_verified` for an address that is exactly the one the invitation names;
// anything else accepts nothing, links nothing and creates nothing. Which account accepts is the database operation's
// to decide: the account the identity is linked to, else the enabled account that holds the invited address verified (the
// identity is linked to it), else an account created for the invited address, whatever the provider's `AUTO_CREATE`
// says because the invitation authorises it (Q31), after the registration policy answered for the path `invitation`. The
// link, the account, the membership, the accepted invitation and the session are one transaction. The browser comes
// back with a full session that acts in the workspace joined, and any other outcome ends on the generic failure.
// The PKCE verifier is sealed together with the instant the handshake began. A callback that cannot open it (its
// secret-box key was removed meanwhile) ends like any other failure. A `reauth` callback hands that instant to
// the identity port, which refuses an ID token that was authenticated before it (doc 04 section 4.5).

type NewFederatedAccount = NonNullable<NonNullable<Parameters<AuthStore["signInWithIdentity"]>[0]["firstLogin"]>["create"]>;

const SUBKEY_BYTES = 32;
const FAILURE_LOCATION = `/login?error=${OIDC_FAILURE_CODE}`;
const MAX_CODE_LENGTH = 2048;
// What is sealed in `oidc_login_states.code_verifier`: the instant the handshake began in milliseconds, a colon
// and the PKCE verifier.
const SEALED_VERIFIER = /^(\d{1,16}):([A-Za-z0-9_-]{1,128})$/;

export interface OidcRoutesOptions {
  readonly store: Pick<
    AuthStore,
    | "createOidcLoginState"
    | "consumeOidcLoginState"
    | "signInWithIdentity"
    | "linkIdentity"
    | "reauthenticateWithIdentity"
    | "inspectInvitation"
    | "acceptInvitationWithIdentity"
  >;
  readonly identity: Pick<IdentityPort, "begin" | "complete">;
  /** Seals the PKCE verifier while the handshake is in flight, and opens it at the callback. */
  readonly secretBox: Pick<SecretBoxPort, "seal" | "open">;
  /** The providers of the operator, for what each allows a first login to do. A provider not listed allows no account to be created. */
  readonly providers: readonly Pick<IdentityProviderConfig, "slug" | "autoCreate" | "allowedDomains">[];
  /** The settings in force for public registration: an account created for an identity gets a personal workspace when it is open. */
  readonly registration: RegistrationSettings;
  /** `APP_ORIGIN`: the callback address registered with the providers, and the scheme of the cookies. */
  readonly appOrigin: string;
  /** `SESSION_SECRET`: the pre-auth cookie is a keyed hash made with a key derived from it. */
  readonly sessionSecret: string;
  readonly sessionCookie: SessionCookieSpec;
  /** Counts the redemption of an invitation token by a start of the `invite` intent against the `token_redeem` limits. */
  readonly takeRedeemLimit: TakeTokenRedeemLimit;
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
  | "exchange_failed"
  | "verifier_unreadable"
  | "invalid_token"
  | "unknown_identity"
  | "unverified_email"
  | "registration_refused"
  | "first_login_refused"
  | "no_session"
  | "cross_site_start"
  | "session_mismatch"
  | "reauth_required"
  | "identity_in_use"
  | "unknown_account"
  | "invalid_invitation"
  | `invitation_${Exclude<InvitationIdentityResult["kind"], "accepted">}`;

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
// and the address bar or a bookmark (`none`) may start a link, a re-authentication or the acceptance of an
// invitation. A page of another site, a sibling subdomain included, may not, and neither may a request that
// carries no such header: a browser that does not send it cannot show the request came from the application, so it
// fails closed there. Such a browser cannot link, re-authenticate or accept an invitation through a provider (it
// accepts by signing in or registering on the invitation page); a sign-in through a provider (`login`) is not
// affected. An account with a password re-authenticates with it, one with a second factor and no password uses a
// code, and one with neither cannot re-authenticate on that browser.
function fromTheApplication(context: ChainContext): boolean {
  const site = context.req.raw.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}

/** The job of a domain event the acceptance queues. */
function eventJob(event: InvitationSignupEvent) {
  return event.name === "account.created"
    ? queueDomainEvent(event.eventId, event.name, event.payload)
    : queueDomainEvent(event.eventId, event.name, event.payload);
}

function refused(context: ChainContext, provider: string, reason: Refusal): void {
  context.get("logger")?.warn("An OIDC sign-in ended without a session", { provider, reason });
}

export function oidcRoutes({
  store,
  identity,
  secretBox,
  providers,
  registration,
  appOrigin,
  sessionSecret,
  sessionCookie,
  takeRedeemLimit,
  now = Date.now,
}: OidcRoutesOptions): RouteBinding[] {
  const preAuth = oidcPreAuthCookieSpec(appOrigin);
  const origin = new URL(appOrigin).origin;
  const bindingKey = Buffer.from(hkdfSync("sha256", sessionSecret, "", "slugbase:oidc:pre-auth", SUBKEY_BYTES));
  const redirectUriOf = (provider: string): string => `${origin}/api/v1/auth/oidc/${provider}/callback`;
  const failure = { status: 302, headers: { Location: FAILURE_LOCATION, "Set-Cookie": clearPreAuthCookie(preAuth) } } as const;

  // The account to create for a first login whose address is verified, or undefined when the provider does not create
  // accounts, the address is outside its domains, or the registration policy refuses it. The policy is asked only here,
  // when creating is the one thing left to do, so linking an account that exists is never a registration.
  const accountFor = async (context: ChainContext, provider: string, claims: IdentityClaims, email: string): Promise<NewFederatedAccount | undefined> => {
    const policy = providers.find((candidate) => candidate.slug === provider);
    if (policy?.autoCreate !== true || !autoCreateAllowed(email, policy.allowedDomains)) {
      return undefined;
    }
    if (!(await registrationAllowed(context, provider, email, "oidc"))) {
      return undefined;
    }
    const accountId = uuidv7();
    return {
      accountId,
      displayName: federatedDisplayName(claims.displayName, email),
      locale: registrationLocale(context.req.raw.headers.get("accept-language")),
      onCreated: [queueDomainEvent(uuidv7(), "account.created", { accountId, path: "oidc" })],
      ...(registration.publicRegistration ? { afterCreated: provisionWorkspaceIn } : {}),
    };
  };

  // Whether the registration policy of the composed modules lets an account be created for the address by the path.
  const registrationAllowed = async (context: ChainContext, provider: string, email: string, path: "oidc" | "invitation"): Promise<boolean> => {
    const hooks = context.get("hooks");
    if (hooks === undefined) {
      throw new Error("the OIDC callback was reached without the hook dispatcher");
    }
    try {
      await assertRegistrationAllowed(hooks, { email, path });
    } catch (error) {
      if (error instanceof ProblemError && error.code === "registration_refused") {
        refused(context, provider, "registration_refused");
        return false;
      }
      throw error;
    }
    return true;
  };

  // The callback of the `invite` intent, once the identity port has verified the ID token. Only an address the provider
  // asserted as verified does anything, and the database operation accepts only when it is exactly the invited one; the
  // registration policy is asked, for the path `invitation`, only when no account holds the invited address, which is
  // the one case that can end in an account being created.
  const acceptInvitationThrough = async (
    context: ChainContext,
    provider: string,
    record: { readonly invitationTokenHash: Buffer | null; readonly returnTo: string },
    claims: IdentityClaims,
    cookieHeader: string | null,
  ) => {
    const email = claims.emailVerified ? normalizeEmail(claims.email) : "";
    if (email === "") {
      refused(context, provider, "unverified_email");
      return failure;
    }
    const tokenHash = record.invitationTokenHash;
    const invitation = tokenHash === null ? undefined : await store.inspectInvitation(tokenHash);
    if (tokenHash === null || invitation === undefined) {
      refused(context, provider, "invitation_gone");
      return failure;
    }
    const mayCreate = !invitation.accountExists && (await registrationAllowed(context, provider, normalizeEmail(invitation.email), "invitation"));
    const token = newSessionToken();
    const carried = cookieHeader === null ? undefined : readCookie(cookieHeader, sessionCookie.name);
    const outcome = await acceptInvitationWithIdentity(
      {
        store: {
          acceptWithIdentity: (acceptance) =>
            store.acceptInvitationWithIdentity({
              ...acceptance,
              onAccepted: (accepted) => {
                const { audit, events } = acceptance.onAccepted(accepted);
                return { audit, jobs: events.map(eventJob) };
              },
            }),
        },
        newId: uuidv7,
      },
      {
        tokenHash,
        provider,
        subject: claims.subject,
        email,
        displayName: federatedDisplayName(claims.displayName, email),
        locale: registrationLocale(context.req.raw.headers.get("accept-language")),
        mayCreate,
        // Seats are unlimited until the entitlement engine supplies a limit (doc 01 section 13.1).
        seatLimit: null,
        session: {
          id: uuidv7(),
          tokenHash: token.hash,
          replacedTokenHash: carried === undefined ? null : (hashSessionToken(carried) ?? null),
          ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null,
          userAgent: truncateUserAgent(context.req.raw.headers.get("user-agent")),
        },
      },
    );
    if (outcome.kind !== "accepted") {
      refused(context, provider, `invitation_${outcome.kind}`);
      return failure;
    }
    return { status: 302, headers: { Location: safeReturnTo(record.returnTo), "Set-Cookie": setSessionCookie(sessionCookie, token.value) } } as const;
  };

  const start = route(startOidcSignIn).handle(async ({ params, query }, context) => {
    const intent = query.intent;
    let linkAccountId: string | null = null;
    let invitationTokenHash: Buffer | undefined;
    if (intent === "invite") {
      if (!fromTheApplication(context)) {
        refused(context, params.provider, "cross_site_start");
        return failure;
      }
      // The redemption is counted whether or not the text is a token, like every other redemption.
      await takeRedeemLimit(context, signedInSession(context)?.accountId);
      invitationTokenHash = query.invitation === undefined ? undefined : hashCredentialToken(query.invitation);
      if (invitationTokenHash === undefined) {
        refused(context, params.provider, "invalid_invitation");
        return failure;
      }
    } else if (intent !== "login") {
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
    const sealed = await secretBox.seal(new TextEncoder().encode(`${String(now())}:${handshake.codeVerifier}`), oidcCodeVerifierOptions(handshake.stateHash));
    await store.createOidcLoginState({
      stateHash: handshake.stateHash,
      provider: params.provider,
      intent,
      nonce: handshake.nonce,
      codeVerifier: sealed,
      // The browser of an invitation comes back to Home, where the workspace it joined is the active one: a path of the
      // request could carry the token into the record, so none is read.
      returnTo: intent === "invite" ? "/" : safeReturnTo(query.returnTo),
      linkAccountId,
      ...(invitationTokenHash === undefined ? {} : { invitationTokenHash }),
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
    // A link or a re-authentication is the work of the account that started it: the browser must still hold a
    // complete session of that account, not merely the pre-auth cookie of the handshake.
    let owner: ReturnType<typeof signedInSession>;
    if (record.intent === "link" || record.intent === "reauth") {
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

    // The key that sealed the verifier may be gone by now, and a record from before the instant was sealed with
    // it does not read: either way the handshake cannot be finished, and ends like the others.
    let sealed: { readonly startedAt: number; readonly codeVerifier: string } | undefined;
    try {
      const opened = await secretBox.open(record.codeVerifier, oidcCodeVerifierOptions(stateHash));
      const match = SEALED_VERIFIER.exec(new TextDecoder().decode(opened));
      opened.fill(0);
      sealed = match?.[1] === undefined || match[2] === undefined ? undefined : { startedAt: Number(match[1]), codeVerifier: match[2] };
    } catch {
      sealed = undefined;
    }
    if (sealed === undefined) {
      return fail("verifier_unreadable");
    }
    let claims;
    try {
      claims = await identity.complete({
        providerId: params.provider,
        redirectUri: redirectUriOf(params.provider),
        code,
        nonce: record.nonce,
        codeVerifier: sealed.codeVerifier,
        ...(record.intent === "reauth" ? { authenticatedSince: sealed.startedAt } : {}),
      });
    } catch (error) {
      return fail(describeFailure(error));
    }
    if (claims.providerId !== params.provider) {
      return fail("invalid_token");
    }

    if (record.intent === "invite") {
      return acceptInvitationThrough(context, params.provider, record, claims, cookieHeader);
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
    const signIn = {
      provider: params.provider,
      subject: claims.subject,
      sessionId: uuidv7(),
      ipPrefix: networkPrefixOf(context.get("clientIp")) ?? null,
      userAgent: truncateUserAgent(context.req.raw.headers.get("user-agent")),
      tokenHash: token.hash,
      replacedTokenHash: carried === undefined ? null : (hashSessionToken(carried) ?? null),
    };
    let outcome = await store.signInWithIdentity(signIn);
    if (outcome === "refused") {
      // An identity nobody linked: only an address the provider asserted as verified does anything (T20).
      const email = claims.emailVerified ? normalizeEmail(claims.email) : "";
      if (email === "") {
        return fail("unverified_email");
      }
      outcome = await store.signInWithIdentity({ ...signIn, firstLogin: { identityId: uuidv7(), email } });
      if (outcome === "refused") {
        const create = await accountFor(context, params.provider, claims, email);
        if (create !== undefined) {
          outcome = await store.signInWithIdentity({ ...signIn, firstLogin: { identityId: uuidv7(), email, create } });
        }
      }
      if (outcome === "refused") {
        return fail("first_login_refused");
      }
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
