import { getDashboard as getDashboardOperation } from "@slugbase/contracts";
import { dashboard, SHARE_ENTITLEMENTS, type EntitlementCheck } from "@slugbase/core";
import { dashboardRepository, tagRepository } from "@slugbase/db";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";

// GET /api/v1/dashboard (doc 04 section 10.8, doc 02 section 9.3, doc 10 T1 and T2). It acts in the workspace the request is bound to and names none; the authorization stage lets a
// member through by a session and refuses an API token, since the operation declares no token scope, and the request is in the `read` rate bucket. It answers the caller's own counts,
// quick access, pinned bookmarks, top tags and the state of the Getting started checklist in one transaction; every read names the account of the request as the owner, and the reads are
// the repositories' (src/repositories/dashboard.ts). The quick access holds the forwarding bookmarks shared with the caller that it can read. The count of bookmarks shared with the caller and the
// sharing block are answered only where the workspace holds `sharing.members` or `sharing.teams`, decided with the check stage 9 uses before the database is touched, and are null otherwise; an
// error of the entitlement source ends the request with an error, never with a grant.

const NO_WORKSPACE = "No such resource.";

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

export interface DashboardRoutesOptions {
  /** Decides a sharing entitlement of the workspace the request acts in, as stage 9 does. */
  readonly sharingEntitlements: EntitlementCheck;
}

export function dashboardRoutes({ sharingEntitlements }: DashboardRoutesOptions): RouteBinding[] {
  /** Whether the workspace may share with members or with teams, which is when the sharing counts are shown. */
  async function sharingGranted(context: ChainContext, tenant: RequestTenant): Promise<boolean> {
    const subject = { accountId: tenant.accountId, workspaceId: tenant.workspaceId };
    for (const entitlement of Object.values(SHARE_ENTITLEMENTS)) {
      if (await sharingEntitlements(entitlement, subject, context.req.raw)) {
        return true;
      }
    }
    return false;
  }

  return [
    route(getDashboardOperation).handle(async (_request, context) => {
      const tenant = tenantOf(context);
      const sharing = await sharingGranted(context, tenant);
      const answer = await tenant.withTenant((tx) => dashboard({ store: dashboardRepository(tx), tags: tagRepository(tx) }, { accountId: tenant.accountId, sharing }));
      if (answer === undefined) {
        throw new ProblemError("unauthenticated", "Authentication is required.");
      }
      return {
        status: 200,
        body: {
          counts: answer.counts,
          quickAccess: answer.quickAccess.map((entry) => ({ ...entry })),
          pinned: answer.pinned.map((entry) => ({ ...entry })),
          topTags: answer.topTags.map((entry) => ({ ...entry })),
          sharing: answer.sharing,
          onboarding: answer.onboarding,
        },
      };
    }),
  ];
}
