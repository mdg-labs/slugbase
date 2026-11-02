import { importJson as importJsonOperation } from "@slugbase/contracts";
import { previewImport, type BookmarkEntitlements } from "@slugbase/core";
import { importRepository } from "@slugbase/db";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError, VALIDATION_FAILED_DETAIL } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";

// POST /api/v1/import/json?dryRun=true (doc 04 section 10.9, doc 02 section 13.1, doc 10 T1 and T13). It acts in the workspace the request is bound to and names none; the authorization stage lets a member
// through by a session or by an API token of the write scope, the body-limits stage refuses a body over 5 MiB, the validation stage refuses a file that is not the format, the handler a request without `dryRun=true`, and the request is in the `bulk` rate
// bucket. The operation is synchronous. This release only previews: the handler reads the workspace's bookmark counter and the caller's own canonical URLs in one transaction and writes nothing, so a request
// that carries an `Idempotency-Key` stores its answer under the key (the idempotency stage's own row) and changes nothing else. Every read names the workspace and the account of the request, so another
// member's bookmark and anything of another workspace is no duplicate of the file's.

const NO_WORKSPACE = "No such resource.";

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

export interface ImportRoutesOptions {
  /** Gives the workspace's `bookmarks.max`, the ceiling of the room the import is previewed against. */
  readonly entitlements: BookmarkEntitlements;
}

export function importRoutes({ entitlements }: ImportRoutesOptions): RouteBinding[] {
  return [
    route(importJsonOperation).handle(async ({ query, body }, context) => {
      const tenant = tenantOf(context);
      // The preview is the only thing this release does. The query is checked here and not by the schema, so that a caller who is not allowed to make the request is told so before anything about its query.
      if (query.dryRun !== "true") {
        throw new ProblemError("validation_failed", VALIDATION_FAILED_DETAIL, { errors: [{ path: "dryRun", code: "invalid_value" }] });
      }
      const ceiling = await entitlements.limit(tenant.accountId, tenant.workspaceId, context.req.raw);
      if (ceiling === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      const outcome = await tenant.withTenant((tx) => previewImport({ store: importRepository(tx) }, { file: body, skipDuplicates: query.skipDuplicates !== "false", ceiling }));
      if (outcome.kind === "unavailable") {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      return { status: 200, body: outcome.result };
    }),
  ];
}
