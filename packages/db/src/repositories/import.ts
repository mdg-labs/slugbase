import type { ImportStore } from "@slugbase/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";

// The reads of the import preview and the writes of the import (doc 02 section 13.1, doc 01 section 7.5, doc 10 T1 and T11). Every statement names the workspace of the transaction, and the duplicate check names the account of the
// transaction as the owner as well, so another member's bookmark, a bookmark with no owner and anything of another workspace is never a duplicate. A plan-archived bookmark is not one either: the
// lookup walks `bookmarks_owner_url_idx`, which holds the bookmarks that are not archived. The room under the workspace's ceiling is read from the counter of its row, which a creation keeps in step with the bookmarks
// that are not archived, and never from a count of the bookmarks. The import takes its places under the ceiling with `sys_bookmark_count_take_many`, which locks the workspace's row and raises the counter once for the
// whole import, and inserts the bookmarks in batches of one statement each in the same transaction, so a failure of any of them leaves neither a bookmark nor a place taken. A bookmark is written for the account of the
// transaction in the workspace of the transaction and for no other.

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the import needs a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

interface CountRow extends Record<string, unknown> {
  bookmark_count: number;
}

interface TakenManyRow extends Record<string, unknown> {
  outcome: string;
  taken: number | null;
  used: number | null;
}

/** The store of the import, less the events: they reach the repository as the jobs that announce them. */
export interface ImportRepository extends Omit<ImportStore, "insertBookmarks"> {
  /** Inserts the bookmarks, in the order given, for the account of the transaction, and queues the jobs; every method needs a transaction opened with a workspace. */
  insertBookmarks(batch: { readonly bookmarks: Parameters<ImportStore["insertBookmarks"]>[0]["bookmarks"]; readonly jobs: readonly QueuedJob[] }): Promise<void>;
}

/** The reads and writes of the import bound to the open transaction; every method needs a transaction opened with a workspace. */
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

    async takePlaces(ceiling, wanted) {
      const workspaceId = requireWorkspace(tx);
      const taken = await tenantHandle(tx).execute<TakenManyRow>(sql`
        SELECT outcome, taken, used FROM public.sys_bookmark_count_take_many(${workspaceId}::uuid, ${ceiling}::integer, ${wanted}::integer)`);
      const row = taken[0];
      if (taken.length !== 1 || row === undefined) {
        throw new Error("sys_bookmark_count_take_many did not return exactly one row");
      }
      if (row.outcome === "unavailable") {
        return { kind: "unavailable" };
      }
      if ((row.outcome !== "taken" && row.outcome !== "limit_reached") || row.taken === null || row.used === null) {
        throw new Error("sys_bookmark_count_take_many returned an answer outside taken, limit_reached and unavailable");
      }
      return { kind: "taken", taken: row.taken, used: row.used };
    },

    async insertBookmarks({ bookmarks: batch, jobs }) {
      const workspaceId = requireWorkspace(tx);
      if (batch.some((bookmark) => bookmark.ownerId.toLowerCase() !== tx.accountId.toLowerCase())) {
        throw new Error("only the account of the transaction imports its own bookmarks");
      }
      if (batch.length > 0) {
        const rows = JSON.stringify(
          batch.map((bookmark) => ({ id: bookmark.id, url: bookmark.url, canonical: bookmark.urlCanonical, host: bookmark.host, title: bookmark.title, description: bookmark.description, pinned: bookmark.pinned })),
        );
        await tenantHandle(tx).execute(sql`
          INSERT INTO public.bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, description, pinned_at)
          SELECT r.id, ${workspaceId}::uuid, ${tx.accountId}::uuid, r.url, r.canonical, r.host, r.title, r.description, CASE WHEN r.pinned THEN now() END
          FROM jsonb_to_recordset(${rows}::text::jsonb) AS r(id uuid, url text, canonical text, host text, title text, description text, pinned boolean)`);
      }
      for (const job of jobs) {
        await enqueueInTenantTransaction(tx, job);
      }
    },
  };
}
