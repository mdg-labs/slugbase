import { checkSlugAvailability as checkSlugAvailabilityOperation } from "@slugbase/contracts";
import { slugAvailability, type SlugAvailabilityStore } from "@slugbase/core";
import { bookmarkRepository, type TenantTx } from "@slugbase/db";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";

// GET /api/v1/slugs/availability (doc 04 section 10.6, doc 02 section 6.1, doc 05 section 2.4, doc 10 T2). It acts in the workspace the request is
// bound to and names none (D11): `?slug=&bookmarkId=` answers `available`, `taken_by_me` (the caller already uses the slug on another bookmark of the
// workspace) or `invalid` (outside the grammar once trimmed and lower-cased), and `othersUseCount`, how many bookmarks of other members, and of members
// who have left, have it: a count, never whose, for the collision hint. A slug other members use does not make it unavailable, since a slug is unique per
// owner. Passing the caller's own `bookmarkId` leaves that bookmark out of the comparison, so its current slug is `available`; a `bookmarkId` that is
// another member's, another workspace's, plan-archived or unknown is `404 not_found`, the answer every bookmark of someone else's gets.

const NO_WORKSPACE = "No such resource.";
const NO_SUCH_BOOKMARK = "No such resource.";

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** The core store over the repository of the open transaction. */
function storeOf(tx: TenantTx): SlugAvailabilityStore {
  const repository = bookmarkRepository(tx);
  return { slugUse: (request) => repository.slugUse(request), find: (bookmarkId) => repository.find(bookmarkId) };
}

export function slugRoutes(): RouteBinding[] {
  return [
    route(checkSlugAvailabilityOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) => slugAvailability({ store: storeOf(tx) }, { accountId: tenant.accountId, slug: query.slug, bookmarkId: query.bookmarkId }));
      if (outcome.kind === "bookmark_not_found") {
        throw new ProblemError("not_found", NO_SUCH_BOOKMARK);
      }
      return { status: 200, body: { status: outcome.status, othersUseCount: outcome.othersUseCount } };
    }),
  ];
}
