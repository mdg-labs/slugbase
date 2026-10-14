import type { SessionCookieSpec } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import type { CookieAuthenticator, SessionPrincipal } from "../http/authenticate.ts";
import { readCookie } from "./cookie.ts";
import { hashSessionToken } from "./session-token.ts";

export interface SessionAuthenticatorOptions {
  readonly store: Pick<AuthStore, "lookupSession">;
  readonly cookie: SessionCookieSpec;
}

/**
 * The cookie authenticator of stage 4 (doc 01 section 4): the session cookie
 * becomes a session principal through one `sys_session_lookup` round trip, so a
 * revoked, expired or disabled session is refused on the very next request (doc
 * 10 T4). A cookie that is absent or malformed, or a token the database does not
 * know, is no principal. A database that cannot answer is an error, never an
 * anonymous request.
 */
export function createSessionAuthenticator({ store, cookie }: SessionAuthenticatorOptions): CookieAuthenticator {
  return {
    credential: "cookie",
    async authenticate(header) {
      const value = readCookie(header, cookie.name);
      const tokenHash = value === undefined ? undefined : hashSessionToken(value);
      if (tokenHash === undefined) {
        return undefined;
      }
      const session = await store.lookupSession(tokenHash);
      if (session === undefined) {
        return undefined;
      }
      const principal: SessionPrincipal = {
        kind: "session",
        sessionId: session.sessionId,
        accountId: session.accountId,
        activeWorkspaceId: session.activeWorkspaceId ?? undefined,
        instanceAdmin: session.isInstanceAdmin,
        ...(session.level === "partial" ? { mfaPending: true } : {}),
        ...(session.reauthAt === null ? {} : { reauthAt: session.reauthAt }),
      };
      return principal;
    },
  };
}
