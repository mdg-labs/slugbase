import { getDashboard as getDashboardOperation } from "@slugbase/contracts";
import { dashboard } from "@slugbase/core";
import { dashboardRepository, tagRepository } from "@slugbase/db";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";

// GET /api/v1/dashboard (doc 04 section 10.8, doc 02 section 9.3, doc 10 T1 and T2). It acts in the workspace the request is bound to and names none; the authorization stage lets a
// member through by a session and refuses an API token, since the operation declares no token scope, and the request is in the `read` rate bucket. It answers the caller's own counts,
// quick access, pinned bookmarks, top tags and the state of the Getting started checklist in one transaction; every read names the account of the request as the owner, and the reads are
// the repositories' (src/repositories/dashboard.ts). The sharing counts are null until sharing exists.

const NO_WORKSPACE = "No such resource.";

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

export function dashboardRoutes(): RouteBinding[] {
  return [
    route(getDashboardOperation).handle(async (_request, context) => {
      const tenant = tenantOf(context);
      const answer = await tenant.withTenant((tx) => dashboard({ store: dashboardRepository(tx), tags: tagRepository(tx) }, { accountId: tenant.accountId }));
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
