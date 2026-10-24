import type { TenantPrincipal } from "@slugbase/core";
import type { RequestStage } from "./chain.ts";
import { ProblemError } from "./problem.ts";

// Stage 4 of the chain (doc 01 section 4, doc 04 section 4.1): the credential of
// the request becomes a principal. The credentials are resolved by the
// authenticators a module registers; this stage decides which of them may see
// which credential, so no resolver can read a cookie on a request that carries
// an `Authorization` header or on a route with an audience.

/** A signed-in browser session. */
export interface SessionPrincipal extends Extract<TenantPrincipal, { readonly kind: "session" }> {
  /** The session row the cookie resolved to; the handle that ends it. */
  readonly sessionId: string;
  /** The account is a CE instance admin (doc 04 section 10.10). */
  readonly instanceAdmin: boolean;
  /**
   * The password was verified and the second factor is still pending (a
   * `partial` session, doc 04 section 4.3). Absent on a completed session.
   */
  readonly mfaPending?: boolean;
  /**
   * When the session last re-authenticated (doc 04 section 4.4). Absent when it
   * never has, which the authorization stage treats as stale.
   */
  readonly reauthAt?: Date;
}

/** An API token, acting in the one workspace it is bound to (doc 04 section 4.2). */
export interface ApiTokenPrincipal extends Extract<TenantPrincipal, { readonly kind: "api-token" }> {
  /** The token row the bearer resolved to; the audit log names it as the actor of what the token changes. */
  readonly tokenId: string;
  readonly scope: "read" | "read-write";
}

/** Who made the request; a request with no credential has no principal and is anonymous. */
export type Principal = SessionPrincipal | ApiTokenPrincipal;

/**
 * Turns the `Authorization` header into an API-token principal. `authorization`
 * is the whole header value and `clientIp` the client address across the trusted
 * proxy hops (undefined without a socket); the resolver answers `undefined` for a
 * credential it does not accept, and throws only when it cannot decide.
 */
export interface BearerAuthenticator {
  readonly credential: "bearer";
  authenticate(authorization: string, request: { readonly clientIp: string | undefined }): Promise<ApiTokenPrincipal | undefined>;
}

/**
 * Turns the `Cookie` header into a session principal. `cookie` is the whole
 * header value; the resolver answers `undefined` when the session cookie is
 * absent, unknown, expired or revoked.
 */
export interface CookieAuthenticator {
  readonly credential: "cookie";
  authenticate(cookie: string): Promise<SessionPrincipal | undefined>;
}

/** A resolver of one kind of credential, registered by a module. */
export type Authenticator = BearerAuthenticator | CookieAuthenticator;

export interface AuthenticationOptions {
  readonly authenticators: readonly Authenticator[];
}

/**
 * Stage 4. Without a registered authenticator every request is anonymous. With
 * one, an `Authorization` header is resolved by the bearer authenticators only
 * and the request is `401 unauthenticated` when none accepts it (cookies are
 * never consulted then); while no bearer authenticator is registered nothing
 * can accept the header, so the request is anonymous, still without its
 * cookies. Otherwise the `Cookie` header goes to the cookie authenticators, and
 * a cookie none accepts is an anonymous request. A route with an `audience`
 * never derives a principal, and a request that matches no operation resolves
 * no credential.
 */
export function createAuthentication({ authenticators }: AuthenticationOptions): RequestStage {
  const bearer = authenticators.filter((authenticator) => authenticator.credential === "bearer");
  const cookie = authenticators.filter((authenticator) => authenticator.credential === "cookie");

  return async (context, next) => {
    const route = context.get("route");
    if (authenticators.length === 0 || route === undefined || route.operation.audience !== undefined) {
      return next();
    }

    const headers = context.req.raw.headers;
    const authorization = headers.get("authorization");
    if (authorization !== null) {
      if (bearer.length === 0) {
        return next();
      }
      for (const authenticator of bearer) {
        const principal = await authenticator.authenticate(authorization, { clientIp: context.get("clientIp") });
        if (principal !== undefined) {
          context.set("principal", principal);
          context.set("principalType", "api-token");
          return next();
        }
      }
      throw new ProblemError("unauthenticated", "The credential was not accepted.");
    }

    const cookies = headers.get("cookie");
    if (cookies !== null) {
      for (const authenticator of cookie) {
        const principal = await authenticator.authenticate(cookies);
        if (principal !== undefined) {
          context.set("principal", principal);
          context.set("principalType", "session");
          return next();
        }
      }
    }
    return next();
  };
}
