import { deleteFormerContent, listFormerBookmarks, listFormerFolders, reassignFormerContent } from "@slugbase/contracts";
import { createAuditWriter, type AuditActor } from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, formerContentRepository } from "@slugbase/db";
import { z } from "zod";
import { uuidv7 } from "../../auth/uuidv7.ts";
import { createPageCursorCodec, type PageCursorCodec } from "../../auth/page-cursor.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";

// GET /api/v1/workspace/former-content/bookmarks and GET /api/v1/workspace/former-content/folders (doc 04 section 10.5, doc 02 sections 2.10 and 3.6,
// doc 10 T1 and T2): the bookmarks and folders of the active workspace that have no owner, which the workspace's admins and owners read on the
// members page. Both are an admin's and declare no token scope, so a member is refused 403 and an API token never reaches them; neither is on the
// list of the operations an export-only account may call, so that period refuses them too (src/http/access-mode.ts). They act in the workspace the
// request is bound to, which the tenant stage resolved from the session, and name no row: which rows a list holds is the repository's rule
// (packages/db/src/repositories/former-content.ts). Each list pages by a keyset cursor signed with a key derived for that list and bound to the
// workspace, so a cursor of one list or of one workspace is refused 400 by another.
//
// POST /api/v1/workspace/former-content/delete deletes the rows of those lists the request names, for good (doc 04 section 10.5, doc 02 section 2.10, doc 10 T1, T2 and T11).
// It is an admin's and session-only like the lists. It is the one place a request deletes content its caller does not own, so the repository's method is the only database
// path to it (`sys_former_content_delete`, which holds the rule of which rows go and of who may call it); the route adds the audit event, in the transaction of the deletion, so
// the rows, the workspace's bookmark count and the event commit or roll back together. An identifier that names no such row is skipped and not told apart from another. A request
// that deletes nothing writes no event. The function answers nothing when the caller is no owner or admin any more or the workspace is being deleted, and that is 404: the
// authorization stage has already refused a caller who is not an admin with 403, so it can only be a role lost during the request.
//
// POST /api/v1/workspace/former-content/reassign gives the rows of those lists the request names to a member of the workspace (doc 04 section 10.5, doc 02 sections 2.10 and 3.6, doc 10 T1
// and T2). It is an admin's and session-only like the lists, and the repository's method is the only database path to it (`sys_former_content_reassign`, which holds the rules of which rows
// move, of who may call it, that the recipient is a member and of the collisions); the route adds the audit event, in the transaction of the move, so the owners, the removed filings and the
// event commit or roll back together. The workspace's bookmark count does not change. A `transferTo` that is no member of the workspace is 404 naming `transferTo`, a member of another
// workspace included; the caller who is no owner or admin any more, or a workspace being deleted, is the plain 404, so the two are told apart by the membership the repository reads in the same
// transaction. A request that moves nothing writes no event.

const NO_WORKSPACE = "No such resource.";
const NO_SUCH_RECIPIENT = "There is no such member to receive the content.";

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

    route(deleteFormerContent).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const deleted = await tenant.withTenant(async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return undefined;
        }
        const result = await formerContentRepository(tx).delete({ bookmarkIds: body.bookmarkIds ?? [], folderIds: body.folderIds ?? [] });
        if (result !== undefined && (result.bookmarksDeleted > 0 || result.foldersDeleted > 0)) {
          const actor: AuditActor = { type: "account", accountId: tenant.accountId, label: profile.displayName };
          await createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }).write({
            action: "member.former_content_deleted",
            workspaceId: tenant.workspaceId,
            actor,
            metadata: { bookmarks: String(result.bookmarksDeleted), folders: String(result.foldersDeleted) },
            ipPrefix,
          });
        }
        return result;
      });
      if (deleted === undefined) {
        throw new ProblemError("not_found", NO_WORKSPACE);
      }
      return { status: 200, body: deleted };
    }),

    route(reassignFormerContent).handle(async ({ body }, context) => {
      const tenant = tenantOf(context);
      const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
      const outcome = await tenant.withTenant(async (tx) => {
        const profile = await accountProfileRepository(tx).profile();
        if (profile === undefined) {
          return { kind: "refused" } as const;
        }
        const result = await formerContentRepository(tx).reassign({ bookmarkIds: body.bookmarkIds ?? [], folderIds: body.folderIds ?? [], recipientId: body.transferTo });
        if (result.kind === "reassigned" && (result.bookmarksMoved > 0 || result.foldersMoved > 0)) {
          const actor: AuditActor = { type: "account", accountId: tenant.accountId, label: profile.displayName };
          await createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }).write({
            action: "member.former_content_reassigned",
            workspaceId: tenant.workspaceId,
            actor,
            metadata: { transferTo: body.transferTo.toLowerCase(), bookmarks: String(result.bookmarksMoved), folders: String(result.foldersMoved) },
            ipPrefix,
          });
        }
        return result;
      });
      switch (outcome.kind) {
        case "reassigned":
          return {
            status: 200,
            body: {
              bookmarksMoved: outcome.bookmarksMoved,
              foldersMoved: outcome.foldersMoved,
              slugsCleared: outcome.slugsCleared,
              foldersRenamed: outcome.foldersRenamed,
              filingsRemoved: outcome.filingsRemoved,
            },
          };
        case "recipient_not_member":
          throw new ProblemError("not_found", NO_SUCH_RECIPIENT, { errors: [{ path: "transferTo", code: "not_found" }] });
        case "refused":
          throw new ProblemError("not_found", NO_WORKSPACE);
      }
    }),
  ];
}
