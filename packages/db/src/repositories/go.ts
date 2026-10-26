import type { GoAccess, GoBookmarkSummary, GoCandidateSet, GoStore } from "@slugbase/core";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { accounts } from "../schema/accounts.ts";
import { bookmarks } from "../schema/bookmarks.ts";
import { slugPreferences } from "../schema/slug-preferences.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { bookmarkReadableBy, type BookmarkRow } from "./bookmark-access.ts";
import { requireIdentifiers, uuidArray } from "./folder-links.ts";
import { defineScopedRepository } from "./scoped.ts";

// The resolution of a slug in the active workspace (doc 05 sections 2.6 and 4, doc 02 sections 6.2 to 6.4, doc 10 T1, T2 and T12). The candidate scan is the
// query of doc 05 section 4: the bookmarks of the workspace with the slug, forwarding on and not plan-archived, that the account can read
// (`bookmarkReadableBy`), with the account's remembered choice for the slug read beside it. The slug is compared as `text`, which has a leakproof equality, so the policy of
// `bookmarks` leaves it an index condition of `bookmarks_slug_idx`, and the id, owner, URL, forwarding and archive state the scan reads are in that index, so on a vacuumed table
// it is an Index Only Scan (test/go-resolution-plan.integration.test.ts plans it on a workspace of 50 000 bookmarks).
// Titles and hosts are not in the index, so they are read by primary key for the candidates only, afterwards.
//
// A preference is the account's own: `slug_preferences` has a policy on the workspace and the account of the transaction (src/sql/570-slug-preferences.sql),
// and every statement below names both. Remembering a choice is one statement that locks the chosen bookmark `FOR KEY SHARE` and inserts the preference
// only if that bookmark is still a candidate for the account, so a bookmark that was deleted or made unreadable meanwhile is no preference, and a delete of
// the bookmark that follows waits for the transaction; choosing again for the slug replaces the bookmark.

// `slugbase_app` may read the table, insert the four columns of a choice and update the bookmark of an existing choice. Defining the scoped repository enters its
// three methods in the registry the cross-tenant matrix runs against the table (doc 08 section 3.3); the product's write is the upsert in `remember`, which a
// scoped insert cannot express, and its reads are the statements below, which name the account as well as the workspace.
defineScopedRepository("slug_preferences", slugPreferences, {
  methods: ["select", "insert", "update"],
  insertColumns: ["accountId", "slug", "bookmarkId"],
  updateColumns: ["bookmarkId"],
});

export type GoRepository = GoStore;

function requireWorkspace(tx: TenantTx, action: string): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", `${action} needs a tenant transaction opened with a workspace`);
  }
  return tx.workspaceId;
}

function requireAccount(tx: TenantTx, accountId: string, action: string): void {
  if (accountId.toLowerCase() !== tx.accountId.toLowerCase()) {
    throw new Error(`only the account of the transaction ${action} for itself`);
  }
}

/** What the candidate scan answers, by the name of each column. */
type CandidateRow = {
  id: string;
  owner_id: string | null;
  url: string;
  access: GoAccess;
  preferred_id: string | null;
};

/** The columns of the candidates the predicate reads: `c` is the name the statement below gives them. */
const CANDIDATE: BookmarkRow = { ownerId: sql.raw("c.owner_id") };

/**
 * The candidate scan of doc 05 section 4, exported for the test that plans it: the candidates of the slug in the workspace, then the access predicate over
 * them, which sharing (doc 02 section 8) extends with the shares when it is built. `access` is how the account reads the candidate: always as its owner for now, and
 * sharing says which of the other ways applied. Needs a transaction opened with a workspace.
 */
export function candidatesStatement(tx: TenantTx, { slug, accountId }: { readonly slug: string; readonly accountId: string }): SQL {
  const workspaceId = requireWorkspace(tx, "resolving a slug");
  requireAccount(tx, accountId, "resolves a slug");
  return sql`
    WITH candidates AS (
      SELECT ${bookmarks.id} AS id, ${bookmarks.ownerId} AS owner_id, ${bookmarks.url} AS url
      FROM ${bookmarks}
      WHERE ${bookmarks.workspaceId} = ${workspaceId}::uuid AND ${bookmarks.slug} = ${slug} AND ${bookmarks.forwarding} AND ${bookmarks.planArchivedAt} IS NULL
    )
    SELECT c.id, c.owner_id, c.url,
           'owner'::text AS access,
           (SELECT ${slugPreferences.bookmarkId} FROM ${slugPreferences}
            WHERE ${slugPreferences.workspaceId} = ${workspaceId}::uuid AND ${slugPreferences.accountId} = ${accountId}::uuid AND ${slugPreferences.slug} = ${slug}) AS preferred_id
    FROM candidates c
    WHERE ${bookmarkReadableBy(accountId, CANDIDATE)}`;
}

/** The go repository bound to the open transaction; every method needs a transaction opened with a workspace. */
export function goRepository(tx: TenantTx): GoRepository {
  return {
    async candidates({ slug, accountId }): Promise<GoCandidateSet> {
      const rows = await tenantHandle(tx).execute<CandidateRow>(candidatesStatement(tx, { slug, accountId }));
      return {
        candidates: rows.map(({ id, owner_id: ownerId, url, access }) => ({ id, ownerId, url, access })),
        preferredId: rows[0]?.preferred_id ?? undefined,
      };
    },

    async summaries(ids): Promise<readonly GoBookmarkSummary[]> {
      const workspaceId = requireWorkspace(tx, "reading the summaries of bookmarks");
      requireIdentifiers(ids, "reading the summaries of bookmarks");
      if (ids.length === 0) {
        return [];
      }
      return tenantHandle(tx)
        .select({ id: bookmarks.id, title: bookmarks.title, host: bookmarks.host, ownerId: bookmarks.ownerId, ownerName: accounts.displayName })
        .from(bookmarks)
        .leftJoin(accounts, eq(accounts.id, bookmarks.ownerId))
        .where(and(eq(bookmarks.workspaceId, workspaceId), sql`${bookmarks.id} = ANY (${uuidArray(ids)}::uuid[])`, bookmarkReadableBy(tx.accountId)));
    },

    async remember({ slug, bookmarkId, accountId }): Promise<boolean> {
      const workspaceId = requireWorkspace(tx, "remembering a choice");
      requireAccount(tx, accountId, "remembers a choice");
      requireIdentifiers([bookmarkId], "remembering a choice");
      const written = await tenantHandle(tx).execute<{ bookmark_id: string }>(sql`
        WITH chosen AS (
          SELECT ${bookmarks.id} AS id FROM ${bookmarks}
          WHERE ${bookmarks.workspaceId} = ${workspaceId}::uuid AND ${bookmarks.id} = ${bookmarkId}::uuid AND ${bookmarks.slug} = ${slug}
            AND ${bookmarks.forwarding} AND ${bookmarks.planArchivedAt} IS NULL AND ${bookmarkReadableBy(accountId)}
          FOR KEY SHARE
        )
        INSERT INTO ${slugPreferences} (workspace_id, account_id, slug, bookmark_id)
        SELECT ${workspaceId}::uuid, ${accountId}::uuid, ${slug}, chosen.id FROM chosen
        ON CONFLICT (workspace_id, account_id, slug) DO UPDATE SET bookmark_id = EXCLUDED.bookmark_id
        RETURNING bookmark_id`);
      return written.length === 1;
    },
  };
}
