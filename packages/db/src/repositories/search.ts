import type { BookmarkHit, FolderHit, SearchStore, TagHit } from "@slugbase/core";
import { sql } from "drizzle-orm";
import { folders } from "../schema/folders.ts";
import { tags } from "../schema/tags.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";

// The search of doc 02 section 9.1 in the active workspace (doc 05 sections 2.4 and 3.3, doc 10 T1 and T2).
//
// Bookmarks are searched by the system operation `sys_search` (src/sql/590-search.sql): the policy of `bookmarks` is FORCEd and none of the operators of the search is leakproof, so
// as slugbase_app the indexes of the search would serve the workspace alone. The operation takes the workspace and the account from the transaction, never from an argument, and
// answers the bookmarks the account can read (its own, and those shared with it, as `bookmarkReadableBy` says) that are not plan-archived, ranked; this repository passes it the text and the limit and nothing else.
//
// Folders and tags are the caller's own and few: a statement names the workspace and the owner as well as the policy, which puts it on the owner's names in the unique key
// `(workspace_id, owner_id, name)`, and a name matches when it contains the text, without regard to case, the characters `LIKE` reads as wildcards escaped. An exact name comes
// first, then a name that starts with the text, then the rest, each by name.

type BookmarkRow = { id: string; title: string; url: string; host: string; slug: string | null; forwarding: boolean; pinned: boolean };
type FolderRow = { id: string; name: string; icon: string; color: number };
type TagRow = { id: string; name: string };

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "a search needs a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

function requireOwner(tx: TenantTx, accountId: string): string {
  if (accountId.toLowerCase() !== tx.accountId) {
    throw new Error("a search of folders and tags is made for the account of the transaction only");
  }
  return tx.accountId;
}

function requireLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("a search takes a positive whole limit");
  }
}

/** The text with the characters `LIKE` reads as wildcards escaped. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

export type SearchRepository = SearchStore;

/** The search bound to the open transaction; every method needs a transaction opened with a workspace. */
export function searchRepository(tx: TenantTx): SearchRepository {
  return {
    async bookmarks({ text, limit }): Promise<readonly BookmarkHit[]> {
      requireWorkspace(tx);
      requireLimit(limit);
      return tenantHandle(tx).execute<BookmarkRow>(sql`SELECT id, title, url, host, slug, forwarding, pinned FROM sys_search(${text}::text, ${limit}::integer)`);
    },

    async folders({ accountId, text, limit }): Promise<readonly FolderHit[]> {
      const workspaceId = requireWorkspace(tx);
      const ownerId = requireOwner(tx, accountId);
      requireLimit(limit);
      const escaped = escapeLike(text);
      return tenantHandle(tx).execute<FolderRow>(sql`
        SELECT ${folders.id} AS id, ${folders.name}::text AS name, ${folders.icon} AS icon, ${folders.color}::integer AS color
        FROM ${folders}
        WHERE ${folders.workspaceId} = ${workspaceId}::uuid AND ${folders.ownerId} = ${ownerId}::uuid AND ${folders.name}::text ILIKE ${`%${escaped}%`}
        ORDER BY CASE WHEN lower(${folders.name}::text) = lower(${text}::text) THEN 0 WHEN ${folders.name}::text ILIKE ${`${escaped}%`} THEN 1 ELSE 2 END, ${folders.name}, ${folders.id}
        LIMIT ${limit}`);
    },

    async tags({ accountId, text, limit }): Promise<readonly TagHit[]> {
      const workspaceId = requireWorkspace(tx);
      const ownerId = requireOwner(tx, accountId);
      requireLimit(limit);
      const escaped = escapeLike(text);
      return tenantHandle(tx).execute<TagRow>(sql`
        SELECT ${tags.id} AS id, ${tags.name}::text AS name
        FROM ${tags}
        WHERE ${tags.workspaceId} = ${workspaceId}::uuid AND ${tags.ownerId} = ${ownerId}::uuid AND ${tags.name}::text ILIKE ${`%${escaped}%`}
        ORDER BY CASE WHEN lower(${tags.name}::text) = lower(${text}::text) THEN 0 WHEN ${tags.name}::text ILIKE ${`${escaped}%`} THEN 1 ELSE 2 END, ${tags.name}, ${tags.id}
        LIMIT ${limit}`);
    },
  };
}
