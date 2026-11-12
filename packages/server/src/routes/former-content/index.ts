import { listFormerBookmarks, listFormerFolders } from "@slugbase/contracts";
import { formerContentRepository } from "@slugbase/db";
import { z } from "zod";
import { createPageCursorCodec, type PageCursorCodec } from "../../auth/page-cursor.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { route } from "../register.ts";

// GET /api/v1/workspace/former-content/bookmarks and GET /api/v1/workspace/former-content/folders (doc 04 section 10.5, doc 02 sections 2.10 and 3.6,
// doc 10 T1 and T2): the bookmarks and folders of the active workspace that have no owner, which the workspace's admins and owners read on the
// members page. Both are an admin's and declare no token scope, so a member is refused 403 and an API token never reaches them; neither is on the
// list of the operations an export-only account may call, so that period refuses them too (src/http/access-mode.ts). They act in the workspace the
// request is bound to, which the tenant stage resolved from the session, and name no row: which rows a list holds is the repository's rule
// (packages/db/src/repositories/former-content.ts). Each list pages by a keyset cursor signed with a key derived for that list and bound to the
// workspace, so a cursor of one list or of one workspace is refused 400 by another.

const NO_WORKSPACE = "No such resource.";

export interface FormerContentRoutesOptions {
  /** The server secret the list cursors are signed with, through a key derived for each list alone. */
  readonly cursorSecret: string;
}

/** The workspace the request acts in; the authorization stage has already answered 404 for a request that acts in none. */
function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** The identifier a page resumes after, from the cursor of the request; a cursor this list did not issue for this workspace is 400. */
function afterIdOf(cursors: PageCursorCodec, cursor: string | undefined, workspaceId: string): string | null {
  if (cursor === undefined) {
    return null;
  }
  const decoded = cursors.decode(cursor, workspaceId);
  if (decoded === undefined || !z.uuid().safeParse(decoded).success) {
    throw new ProblemError("bad_request", "The cursor is not valid.");
  }
  return decoded;
}

export function formerContentRoutes({ cursorSecret }: FormerContentRoutesOptions): RouteBinding[] {
  const bookmarkCursors = createPageCursorCodec(cursorSecret, "former-content-bookmarks");
  const folderCursors = createPageCursorCodec(cursorSecret, "former-content-folders");
  return [
    route(listFormerBookmarks).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const afterId = afterIdOf(bookmarkCursors, query.cursor, tenant.workspaceId);
      // One more than the page, to know whether another page follows.
      const fetched = await tenant.withTenant((tx) => formerContentRepository(tx).listBookmarks(afterId, query.limit + 1));
      const page = fetched.slice(0, query.limit);
      const last = page.at(-1);
      return {
        status: 200,
        body: {
          items: page.map(({ id, title, url, host, slug, forwarding, createdAt, updatedAt }) => ({
            id,
            title,
            url,
            host,
            slug,
            forwarding,
            createdAt: createdAt.toISOString(),
            updatedAt: updatedAt.toISOString(),
          })),
          nextCursor: fetched.length > query.limit && last !== undefined ? bookmarkCursors.encode(last.id, tenant.workspaceId) : null,
        },
      };
    }),

    route(listFormerFolders).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      const afterId = afterIdOf(folderCursors, query.cursor, tenant.workspaceId);
      const fetched = await tenant.withTenant((tx) => formerContentRepository(tx).listFolders(afterId, query.limit + 1));
      const page = fetched.slice(0, query.limit);
      const last = page.at(-1);
      return {
        status: 200,
        body: {
          items: page.map(({ id, name, icon, color, bookmarkCount, createdAt }) => ({ id, name, icon, color, bookmarkCount, createdAt: createdAt.toISOString() })),
          nextCursor: fetched.length > query.limit && last !== undefined ? folderCursors.encode(last.id, tenant.workspaceId) : null,
        },
      };
    }),
  ];
}
