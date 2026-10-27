import { search as searchOperation } from "@slugbase/contracts";
import { search, type SearchType } from "@slugbase/core";
import { searchRepository } from "@slugbase/db";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";

// GET /api/v1/search (doc 04 section 10.8, doc 02 section 9.1, Q49, doc 10 T1 and T2). It acts in the workspace the request is bound to and names none; the authorization stage lets a
// member through (a session, or a token of the read scope) and the request is in the `read` rate bucket. It answers the caller's own readable bookmarks, folders and tags that match the
// text, grouped, at most 8, 4 and 4 each unless `limit` (at most 20, per type) says otherwise. The text is never SQL, `tsquery` or `LIKE` syntax; the matching and the ranking are the
// store's (src/sql/590-search.sql for bookmarks), which answers the account and the workspace of the transaction only.

const NO_WORKSPACE = "No such resource.";

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

export function searchRoutes(): RouteBinding[] {
  return [
    route(searchOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const types = query.types === undefined ? undefined : (query.types.split(",") as SearchType[]);
      const results = await tenant.withTenant((tx) => search({ store: searchRepository(tx) }, { accountId: tenant.accountId, query: query.q, types, limit: query.limit }));
      return {
        status: 200,
        body: {
          bookmarks: results.bookmarks.map((hit) => ({ id: hit.id, title: hit.title, url: hit.url, host: hit.host, slug: hit.slug, forwarding: hit.forwarding, pinned: hit.pinned })),
          folders: results.folders.map((hit) => ({ id: hit.id, name: hit.name, icon: hit.icon, color: hit.color })),
          tags: results.tags.map((hit) => ({ id: hit.id, name: hit.name })),
        },
      };
    }),
  ];
}
