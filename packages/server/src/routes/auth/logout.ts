import { logout } from "@slugbase/contracts";
import type { SessionCookieSpec } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { clearSessionCookie } from "../../auth/cookie.ts";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { route } from "../register.ts";

// POST /api/v1/auth/logout (doc 04 section 10.2): deletes the session the
// request is signed in with, so its token is refused from the next request on
// (doc 10 T4), and clears the cookie.

export interface LogoutRouteOptions {
  readonly store: Pick<AuthStore, "revokeSession">;
  readonly cookie: SessionCookieSpec;
}

export function logoutRoute({ store, cookie }: LogoutRouteOptions): RouteBinding {
  return route(logout).handle(async (_request, context) => {
    const principal = context.get("principal");
    if (principal?.kind !== "session") {
      throw new ProblemError("unauthenticated", "Authentication is required.");
    }
    await store.revokeSession(principal.sessionId, principal.accountId);
    return { status: 204, headers: { "Set-Cookie": clearSessionCookie(cookie) } };
  });
}
