import { listSessions, revokeSession, revokeSessions } from "@slugbase/contracts";
import type { SessionCookieSpec } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { z } from "zod";
import { clearSessionCookie } from "../../auth/cookie.ts";
import { createPageCursorCodec } from "../../auth/page-cursor.ts";
import { userAgentFamily } from "../../auth/user-agent.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import { route } from "../register.ts";

// GET /api/v1/me/sessions, DELETE /api/v1/me/sessions/{id} and DELETE
// /api/v1/me/sessions (doc 04 section 10.3). Every call names the signed-in
// account to the database, so a session of another account is neither listed
// nor deleted, and an id of one is answered like an id that does not exist
// (doc 10 T1). A deleted session is refused from its next request on (T4).

export interface SessionRoutesOptions {
  readonly store: Pick<AuthStore, "listSessions" | "revokeSession" | "revokeAllSessions">;
  readonly cookie: SessionCookieSpec;
  /** The server secret the list cursors are signed with, through a key derived for this list alone. */
  readonly cursorSecret: string;
}

function sessionOf(context: ChainContext): { readonly sessionId: string; readonly accountId: string } {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("unauthenticated", "Authentication is required.");
  }
  return principal;
}

export function sessionRoutes({ store, cookie, cursorSecret }: SessionRoutesOptions): RouteBinding[] {
  const cursors = createPageCursorCodec(cursorSecret, "sessions");
  return [
    route(listSessions).handle(async ({ query }, context) => {
      const { sessionId, accountId } = sessionOf(context);
      let afterId: string | null = null;
      if (query.cursor !== undefined) {
        const decoded = cursors.decode(query.cursor, accountId);
        if (decoded === undefined || !z.uuid().safeParse(decoded).success) {
          throw new ProblemError("bad_request", "The cursor is not valid.");
        }
        afterId = decoded;
      }
      // One more than the page, to know whether another page follows.
      const fetched = await store.listSessions(accountId, afterId, query.limit + 1);
      const sessions = fetched.slice(0, query.limit);
      const last = sessions.at(-1);
      return {
        status: 200,
        body: {
          nextCursor: fetched.length > query.limit && last !== undefined ? cursors.encode(last.id, accountId) : null,
          items: sessions.map((session) => ({
            id: session.id,
            createdAt: session.createdAt.toISOString(),
            lastSeenAt: session.lastSeenAt.toISOString(),
            userAgentFamily: userAgentFamily(session.userAgent),
            ipPrefix: session.ipPrefix,
            current: session.id === sessionId,
          })),
        },
      };
    }),

    route(revokeSession).handle(async ({ params }, context) => {
      const { sessionId, accountId } = sessionOf(context);
      if (!(await store.revokeSession(params.id, accountId))) {
        throw new ProblemError("not_found", "There is no such session.");
      }
      return params.id === sessionId ? { status: 204, headers: { "Set-Cookie": clearSessionCookie(cookie) } } : { status: 204 };
    }),

    route(revokeSessions).handle(async ({ query }, context) => {
      const { sessionId, accountId } = sessionOf(context);
      const includeCurrent = query.includeCurrent === "true";
      await store.revokeAllSessions(accountId, includeCurrent ? null : sessionId);
      return includeCurrent ? { status: 204, headers: { "Set-Cookie": clearSessionCookie(cookie) } } : { status: 204 };
    }),
  ];
}
