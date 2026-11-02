import type { ImportPreviewStore } from "@slugbase/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";

// The reads of the import preview (doc 02 section 13.1, doc 01 section 7.5, doc 10 T1). Every statement names the workspace of the transaction, and the duplicate check names the account of the
// transaction as the owner as well, so another member's bookmark, a bookmark with no owner and anything of another workspace is never a duplicate. A plan-archived bookmark is not one either: the
// lookup walks `bookmarks_owner_url_idx`, which holds the bookmarks that are not archived. The room under the workspace's ceiling is read from the counter of its row, which a creation keeps in step with the bookmarks
// that are not archived, and never from a count of the bookmarks.

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the import needs a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

interface CountRow extends Record<string, unknown> {
  bookmark_count: number;
}

export type ImportRepository = ImportPreviewStore;

/** The reads of the import preview bound to the open transaction; every method needs a transaction opened with a workspace. */
export function importRepository(tx: TenantTx): ImportRepository {
  return {
    async bookmarkCount() {
      const workspaceId = requireWorkspace(tx);
      const rows = await tenantHandle(tx).execute<CountRow>(sql`
        SELECT bookmark_count FROM public.workspaces
        WHERE id = ${workspaceId}::uuid AND id IN (SELECT public.app_member_workspace_ids())`);
      return rows[0]?.bookmark_count;
    },

    async existingCanonicalUrls(canonicals) {
      const workspaceId = requireWorkspace(tx);
      if (canonicals.length === 0) {
        return new Set<string>();
      }
      const rows = await tenantHandle(tx)
        .selectDistinct({ canonical: bookmarks.urlCanonical })
        .from(bookmarks)
        .where(and(eq(bookmarks.workspaceId, workspaceId), eq(bookmarks.ownerId, tx.accountId), isNull(bookmarks.planArchivedAt), inArray(bookmarks.urlCanonical, [...canonicals])));
      return new Set(rows.map((row) => row.canonical));
    },
  };
}
