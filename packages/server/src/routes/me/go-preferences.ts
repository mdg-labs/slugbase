import { deleteGoPreference as deleteGoPreferenceOperation, listGoPreferences as listGoPreferencesOperation } from "@slugbase/contracts";
import { forgetGoPreference, listGoPreferences, type GoPreferenceCursors } from "@slugbase/core";
import { goRepository } from "@slugbase/db";
import { createPageCursorCodec } from "../../auth/page-cursor.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";

// GET /api/v1/me/go-preferences and DELETE /api/v1/me/go-preferences/{slug} (doc 04 section 10.3, doc 02 section 6.4, doc 05 section 2.6, doc 10 T1 and T2). Both act in
// the workspace the request is bound to and name none (D11); a session, or a token of the matching scope (read to list, write to forget), is let through by the
// authorization stage. A remembered choice is its member's own: the statements name the account and the policy of the table confines it, so another member's choices and
// those of another workspace are neither listed nor forgotten, and forgetting one is the `404 not_found` of a choice the caller has not got. The list names the choices whose
// bookmark is still a candidate of its slug, in the order of the slugs, in pages of at most 100 that the `nextCursor` resumes (doc 04 section 6.1); the cursor is the last slug,
// signed with a subkey derived from the session secret for this list over the account and the workspace it was issued for, and a forged, altered or mismatched one is
// `400 bad_request`. A bookmark is named by identifier, title, host and owner, never by its address.

const NO_WORKSPACE = "No such resource.";
const NO_SUCH_PREFERENCE = "No such resource.";
const BAD_CURSOR = "The cursor is not valid.";

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

function preferenceCursors(secret: string): GoPreferenceCursors {
  const codec = createPageCursorCodec(secret, "go-preferences");
  return {
    seal: (afterSlug, scope) => codec.encode(afterSlug, scope),
    open: (cursor, scope) => codec.decode(cursor, scope),
  };
}

export interface GoPreferenceRoutesOptions {
  /** The server secret the list cursors are signed with, through a key derived for this list alone. */
  readonly cursorSecret: string;
}

export function goPreferenceRoutes({ cursorSecret }: GoPreferenceRoutesOptions): RouteBinding[] {
  const cursors = preferenceCursors(cursorSecret);
  return [
    route(listGoPreferencesOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) =>
        listGoPreferences({ store: goRepository(tx), cursors }, { workspaceId: tenant.workspaceId, accountId: tenant.accountId, limit: query.limit, cursor: query.cursor }),
      );
      if (outcome.kind === "bad_cursor") {
        throw new ProblemError("bad_request", BAD_CURSOR);
      }
      return { status: 200, body: { items: outcome.items.map((item) => ({ ...item })), nextCursor: outcome.nextCursor } };
    }),

    route(deleteGoPreferenceOperation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      const forgotten = await tenant.withTenant((tx) => forgetGoPreference({ store: goRepository(tx) }, { accountId: tenant.accountId, slug: params.slug }));
      if (!forgotten) {
        throw new ProblemError("not_found", NO_SUCH_PREFERENCE);
      }
      return { status: 204 };
    }),
  ];
}
