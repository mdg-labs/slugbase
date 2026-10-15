import { createApiToken, listApiTokens, revokeApiToken } from "@slugbase/contracts";
import { MAX_API_TOKENS_PER_USER, generateApiToken } from "@slugbase/core";
import { apiTokenRepository, type ApiTokenRecord, type Database } from "@slugbase/db";
import { z } from "zod";
import { createPageCursorCodec } from "../../auth/page-cursor.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import { route } from "../register.ts";

// GET /api/v1/me/api-tokens, POST /api/v1/me/api-tokens and DELETE
// /api/v1/me/api-tokens/{id} (doc 04 section 10.3, doc 02 section 2.9, doc 10
// T4, T7 and T18). The operations declare no token scope, so a bearer request
// is refused before the handler runs, and creating declares `reauth`, so the
// authorization stage has refused a session that has not re-authenticated within
// ten minutes. Every call runs in an account-level transaction for the session's
// own account, on the row-level security of `api_tokens`: another account's
// token is neither listed nor revoked, and its id is answered like one that does
// not exist. The secret is generated here, only its SHA-256 reaches the
// database, and it leaves in the one 201 response; no list, no log line and no
// problem document carries it.

const UNAUTHENTICATED = "Authentication is required.";
const NO_WORKSPACE = "There is no such workspace.";
const NAME_TAKEN = "You already have an API token with this name.";
const LIMIT_REACHED = `You can have at most ${String(MAX_API_TOKENS_PER_USER)} API tokens that are not revoked or expired. Revoke one first.`;

export interface ApiTokenRoutesOptions {
  readonly withTenant: Database["withTenant"];
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

function bodyOf(token: ApiTokenRecord) {
  return {
    id: token.id,
    name: token.name,
    workspaceId: token.workspaceId,
    workspaceName: token.workspaceName,
    scope: token.scope,
    prefix: token.prefix,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    expiresAt: token.expiresAt?.toISOString() ?? null,
  };
}

export function apiTokenRoutes({ withTenant, cursorSecret }: ApiTokenRoutesOptions): RouteBinding[] {
  const cursors = createPageCursorCodec(cursorSecret, "api-tokens");
  return [
    route(listApiTokens).handle(async ({ query }, context) => {
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
      const fetched = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) => apiTokenRepository(tx).list(afterId, query.limit + 1));
      const tokens = fetched.slice(0, query.limit);
      const last = tokens.at(-1);
      return {
        status: 200,
        body: {
          items: tokens.map(bodyOf),
          nextCursor: fetched.length > query.limit && last !== undefined ? cursors.encode(last.id, accountId) : null,
        },
      };
    }),

    route(createApiToken).handle(async ({ body }, context) => {
      const accountId = accountOf(context);
      const workspaceId = body.workspaceId ?? context.get("tenant")?.workspaceId;
      if (workspaceId === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const secret = generateApiToken();
      const outcome = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) =>
        apiTokenRepository(tx).create({
          id: uuidv7(),
          workspaceId,
          name: body.name,
          scope: body.scope,
          tokenHash: secret.hash,
          tokenPrefix: secret.displayPrefix,
          expiresInDays: body.expiresInDays,
          limit: MAX_API_TOKENS_PER_USER,
        }),
      );
      switch (outcome.kind) {
        case "created":
          return { status: 201, body: { ...bodyOf(outcome.token), token: secret.value } };
        case "not_a_member":
          throw new ProblemError("not_found", NO_WORKSPACE);
        case "name_taken":
          throw new ProblemError("name_taken", NAME_TAKEN, { errors: [{ path: "name", code: "name_taken" }] });
        case "limit_reached":
          throw new ProblemError("validation_failed", LIMIT_REACHED, { errors: [{ path: "name", code: "api_token_limit_reached" }] });
      }
    }),

    route(revokeApiToken).handle(async ({ params }, context) => {
      const accountId = accountOf(context);
      const found = await withTenant({ accountId, requestId: requestIdOf(context) }, (tx) => apiTokenRepository(tx).revoke(params.id));
      if (!found) {
        throw new ProblemError("not_found", "There is no such API token.");
      }
      return { status: 204 };
    }),
  ];
}
