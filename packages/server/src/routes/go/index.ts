import { chooseSlug as chooseSlugOperation, resolveSlug as resolveSlugOperation, type GoResolutionSchema } from "@slugbase/contracts";
import { chooseSlugBookmark, resolveInWorkspace, resolveSlug, type BookmarkUsage, type GoResolution } from "@slugbase/core";
import { goRepository } from "@slugbase/db";
import type { z } from "zod";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";

// POST /api/v1/go/resolve and POST /api/v1/go/choose (doc 04 section 10.8, doc 02 sections 6.2 to 6.4, doc 05 section 4, Q25, doc 10 T1, T2 and T12). Both
// act in the workspace the request is bound to and name none (D11), and both are in the `go` rate bucket. The resolution answers what the slug resolves to
// for the caller (a remembered preference, the caller's own bookmark, the one shared bookmark, several shared bookmarks, or none) and names bookmarks
// without their address. A choice names one of the candidates and answers its address, which is checked again to be an http or https URL; it counts the
// use in the usage buffer of this process, as an open does, and remembers the choice when the caller asked. A bookmark that is not a current candidate
// of the slug for the caller (another member's, another workspace's, not forwarding, plan-archived, with another slug or unknown) is `404 slug_not_found`
// and nothing is remembered or counted.

const NO_WORKSPACE = "No such resource.";
const NO_SUCH_SLUG = "No bookmark of yours or shared with you has this slug.";
const DESTINATION_NOT_ALLOWED = "The bookmark's address is not an http or https URL, so it is not opened.";

export interface GoRoutesOptions {
  /** Where a use is counted; the usage buffer of the server process. */
  readonly usage: BookmarkUsage;
}

function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

function bodyOf(resolution: GoResolution): z.input<typeof GoResolutionSchema> {
  switch (resolution.kind) {
    case "none":
      return { result: "none", otherWorkspaces: resolution.otherWorkspaces.map(({ id, name }) => ({ id, name })) };
    case "preferred":
      return { result: "preferred", bookmark: resolution.bookmark };
    case "single":
      return { result: "single", bookmark: resolution.bookmark };
    case "multiple":
      return { result: "multiple", candidates: [...resolution.candidates] };
  }
}

export function goRoutes({ usage }: GoRoutesOptions): RouteBinding[] {
  return [
    route(resolveSlugOperation).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      // A token is bound to its workspace and cannot switch (Q40, doc 04 section 4.2), so a miss for a token names no other workspace and never asks for them.
      const asksOtherWorkspaces = context.get("principal")?.kind === "session";
      const resolution = await tenant.withTenant(async (tx): Promise<GoResolution> => {
        const ask = { accountId: tenant.accountId, slug: body.slug };
        if (asksOtherWorkspaces) {
          return resolveSlug({ store: goRepository(tx) }, ask);
        }
        const inWorkspace = await resolveInWorkspace({ store: goRepository(tx) }, ask);
        return inWorkspace.kind === "none" ? { kind: "none", otherWorkspaces: [] } : inWorkspace;
      });
      return { status: 200, body: bodyOf(resolution) };
    }),

    route(chooseSlugOperation).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const outcome = await tenant.withTenant((tx) =>
        chooseSlugBookmark({ store: goRepository(tx), usage }, { accountId: tenant.accountId, slug: body.slug, bookmarkId: body.bookmarkId, remember: body.remember ?? false }),
      );
      switch (outcome.kind) {
        case "chosen":
          return { status: 200, body: { url: outcome.url } };
        case "not_found":
          throw new ProblemError("slug_not_found", NO_SUCH_SLUG);
        case "url_refused":
          throw new ProblemError("url_not_allowed", DESTINATION_NOT_ALLOWED);
      }
    }),
  ];
}
