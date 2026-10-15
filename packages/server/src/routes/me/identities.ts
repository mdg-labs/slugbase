import { listIdentities, unlinkIdentity } from "@slugbase/contracts";
import { accountIdentityRepository, type AuthStore, type Database } from "@slugbase/db";
import { z } from "zod";
import { createPageCursorCodec } from "../../auth/page-cursor.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import { route } from "../register.ts";

// GET /api/v1/me/identities and DELETE /api/v1/me/identities/{id} (doc 04 sections 4.4 and 10.3, doc 02
// sections 2.5 and 2.8, doc 10 T4 and T18). The operations declare no token scope, so a bearer request is
// refused before the handler runs, and the unlink declares `reauth`, so the authorization stage has refused
// a session that has not re-authenticated within ten minutes. The list runs in an account-level transaction
// on the own-account policy of `account_identities`; the unlink is a system operation that takes the session's
// account, never one the request names, and answers an identity of another account like one that does not
// exist. An identity is unlinked only if the account keeps a password or another identity to sign in with.
// Nothing here returns or logs the provider's subject.

const UNAUTHENTICATED = "Authentication is required.";
const NOT_FOUND = "There is no such identity.";
const LAST_SIGN_IN_METHOD = "This is the only way to sign in to the account. Add a password or link another identity first.";

export interface IdentityRoutesOptions {
  readonly withTenant: Database["withTenant"];
  readonly store: Pick<AuthStore, "unlinkIdentity">;
  /** The server secret the list cursors are signed with, through a key derived for this list alone. */
  readonly cursorSecret: string;
}

function accountOf(context: ChainContext): string {
  const principal = context.get("principal");
  if (principal?.kind !== "session") {
    throw new ProblemError("unauthenticated", UNAUTHENTICATED);
  }
  return principal.accountId;
}

export function identityRoutes({ withTenant, store, cursorSecret }: IdentityRoutesOptions): RouteBinding[] {
  const cursors = createPageCursorCodec(cursorSecret, "identities");
  return [
    route(listIdentities).handle(async ({ query }, context) => {
      const accountId = accountOf(context);
      let afterId: string | null = null;
      if (query.cursor !== undefined) {
        const decoded = cursors.decode(query.cursor, accountId);
        if (decoded === undefined || !z.uuid().safeParse(decoded).success) {
          throw new ProblemError("bad_request", "The cursor is not valid.");
        }
        afterId = decoded;
      }
      // One more than the page, to know whether another page follows.
      const fetched = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) => accountIdentityRepository(tx).list(afterId, query.limit + 1));
      const identities = fetched.slice(0, query.limit);
      const last = identities.at(-1);
      return {
        status: 200,
        body: {
          items: identities.map((identity) => ({
            id: identity.id,
            provider: identity.provider,
            emailAtLink: identity.emailAtLink,
            createdAt: identity.createdAt.toISOString(),
            lastUsedAt: identity.lastUsedAt?.toISOString() ?? null,
          })),
          nextCursor: fetched.length > query.limit && last !== undefined ? cursors.encode(last.id, accountId) : null,
        },
      };
    }),

    route(unlinkIdentity).handle(async ({ params }, context) => {
      const accountId = accountOf(context);
      switch (await store.unlinkIdentity(accountId, params.id)) {
        case "unlinked":
          return { status: 204 };
        case "not_found":
          throw new ProblemError("not_found", NOT_FOUND);
        case "last_sign_in_method":
          throw new ProblemError("validation_failed", LAST_SIGN_IN_METHOD, { errors: [{ path: "id", code: "last_sign_in_method" }] });
      }
    }),
  ];
}
