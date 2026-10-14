import { getMe } from "@slugbase/contracts";
import { accountProfileRepository, membershipRepository, type Database } from "@slugbase/db";
import type { RouteBinding } from "../../http/chain.ts";
import { ProblemError, requestIdOf } from "../../http/problem.ts";
import { route } from "../register.ts";

// GET /api/v1/me (doc 04 section 10.3): the signed-in account with its
// memberships and the workspace the request acts in. It reads the account's own
// row and memberships in an account-level transaction, on row-level security,
// and selects no hash and no secret. A browser error reporter's DSN is the
// session's alone: it is not asked for on behalf of an API token.

export interface ProfileRoutesOptions {
  readonly withTenant: Database["withTenant"];
}

export function profileRoutes({ withTenant }: ProfileRoutesOptions): RouteBinding[] {
  return [
    route(getMe).handle(async (_request, context) => {
      const principal = context.get("principal");
      if (principal === undefined) {
        throw new ProblemError("unauthenticated", "Authentication is required.");
      }
      const { accountId } = principal;
      const { profile, memberships } = await withTenant({ accountId, requestId: requestIdOf(context) }, async (tx) => ({
        profile: await accountProfileRepository(tx).profile(),
        memberships: await membershipRepository(tx).list(),
      }));
      if (profile === undefined) {
        throw new ProblemError("unauthenticated", "Authentication is required.");
      }
      const workspaceId = context.get("tenant")?.workspaceId;
      const dsn = principal.kind === "session" ? await context.get("hooks")?.clientErrorReportDsn({ accountId, workspaceId }) : null;
      return {
        status: 200,
        body: {
          account: {
            id: profile.id,
            email: profile.email,
            displayName: profile.displayName,
            locale: profile.locale,
            theme: profile.theme,
            accent: profile.accent,
            defaultView: profile.defaultBookmarkView,
            aiOptOut: profile.aiOptOut,
            emailVerified: profile.emailVerified,
            hasPassword: profile.hasPassword,
          },
          memberships: memberships.map(({ workspaceId: id, name, role }) => ({ workspaceId: id, name, role })),
          activeWorkspaceId: workspaceId ?? null,
          ...(dsn === null || dsn === undefined ? {} : { clientErrorReportDsn: dsn }),
        },
      };
    }),
  ];
}
