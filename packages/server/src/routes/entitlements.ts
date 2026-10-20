import { getEntitlements } from "@slugbase/contracts";
import type { EntitlementService } from "@slugbase/core";
import { entitlementRepository, type Database } from "@slugbase/db";
import type { ChainContext } from "../http/chain.ts";
import { ProblemError, requestIdOf } from "../http/problem.ts";
import { route } from "./register.ts";

// GET /api/v1/entitlements (doc 04 section 10.4, doc 01 section 7.5, doc 10 T11) reads what the composition's
// entitlement source grants the workspace the request acts in and the acting account, and the counters the
// limits are compared with: `bookmarks.used` from the workspace's `bookmark_count`, `seats.used` from its
// members and `workspaces.owned` from the workspaces the account owns. The values come from the engine, never
// from an edition flag (D4): it reads the workspace's `entitlement_version`, serves the cached set while that
// version stands and asks the source again when it moved. The account-scoped values are asked of the source on
// this request and never cached. The operation is a member's and takes a read-scope token; it decides nothing,
// and the enforcement points check on the server whatever the UI does with the answer.

const NO_WORKSPACE = "No such resource.";

export interface EntitlementRoutesOptions {
  readonly withTenant: Database["withTenant"];
  readonly service: EntitlementService;
}

function accountOf(context: ChainContext): string {
  const principal = context.get("principal");
  if (principal === undefined) {
    throw new ProblemError("unauthenticated", "Authentication is required.");
  }
  return principal.accountId;
}

export function entitlementRoutes({ withTenant, service }: EntitlementRoutesOptions) {
  return [
    route(getEntitlements).handle(async (_request, context) => {
      const accountId = accountOf(context);
      const tenant = context.get("tenant");
      if (tenant === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const entitlements = service.forRequest(context.req.raw, accountId);
      const [workspace, account] = await Promise.all([entitlements.forWorkspace(tenant.workspaceId), entitlements.forAccount()]);
      if (workspace === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const counted = await withTenant({ accountId, workspaceId: tenant.workspaceId, requestId: requestIdOf(context) }, async (tx) => {
        const repository = entitlementRepository(tx);
        return { usage: await repository.usage(), owned: await repository.ownedWorkspaces() };
      });
      if (counted.usage === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      return {
        status: 200,
        body: {
          entitlements: { ...workspace.values, ...account.values },
          usage: { "bookmarks.used": counted.usage.bookmarksUsed, "seats.used": counted.usage.seatsUsed, "workspaces.owned": counted.owned },
          upgradeAvailable: workspace.upgradeAvailable,
        },
      };
    }),
  ];
}
