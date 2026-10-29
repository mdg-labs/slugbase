import type { GoAccess, GoBookmarkSummary, GoCandidateSet, GoPreferenceRecord, GoPreferenceStore, GoStore, GoSuggestionRecord, GoSuggestStore, GoWorkspace } from "@slugbase/core";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { accounts } from "../schema/accounts.ts";
import { bookmarks } from "../schema/bookmarks.ts";
import { slugPreferences } from "../schema/slug-preferences.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { bookmarkAccessOf, bookmarkReadableBy, type SharableBookmarkRow } from "./bookmark-access.ts";
import { requireIdentifiers, uuidArray } from "./folder-links.ts";
import { defineScopedRepository } from "./scoped.ts";

// The resolution of a slug in the active workspace (doc 05 sections 2.6 and 4, doc 02 sections 6.2 to 6.4, doc 10 T1, T2 and T12). The candidate scan is the
// query of doc 05 section 4: the bookmarks of the workspace with the slug, forwarding on and not plan-archived, that the account can read
// (`bookmarkReadableBy`), with the account's remembered choice for the slug read beside it. The slug is compared as `text`, which has a leakproof equality, so the policy of
// `bookmarks` leaves it an index condition of `bookmarks_slug_idx`, and the id, owner, URL, forwarding and archive state the scan reads are in that index, so on a vacuumed table
// it is an Index Only Scan (test/go-resolution-plan.integration.test.ts plans it on a workspace of 50 000 bookmarks). The access predicate and the route that gives access (`access`: the
// account's own bookmark, or the direct, team or folder share that gives it) are correlated probes of the share tables for each candidate of the slug, which are few, and read no more of the bookmarks.
// Titles and hosts are not in the index, so they are read by primary key for the candidates only, afterwards.
//
// A slug that resolves to nothing is asked about once more across the account's other workspaces (`otherWorkspaces`), which the tenant policies cannot do, since they show one
// workspace at a time: the system operation `sys_go_other_workspaces` (src/sql/580-go-other-workspaces.sql) takes the account from the transaction, never from an argument,
// and answers the identifier and the name of each other workspace of which the account is a member and in which it can read a forwarding, non-archived bookmark with the slug
// (its own, or one shared with it, as `bookmarkReadableBy` says), and no bookmark.
//
// The suggestions of the palette's `go` mode (`suggest`) are the system operation `sys_go_suggest` (src/sql/600-go-suggest.sql): the bookmarks of the workspace whose slug starts with a
// prefix, with the candidate rule of the scan above and its access rule (`bookmarkReadableBy`): the account's own first, then the ones shared with it. A prefix is a `LIKE` condition, which is not leakproof, so as `slugbase_app` it could not be an
// index condition under the policy of `bookmarks`; the operation takes the workspace and the account from the transaction, never from an argument, and this repository passes it the prefix alone.
//
// A preference is the account's own: `slug_preferences` has a policy on the workspace and the account of the transaction (src/sql/570-slug-preferences.sql),
// and every statement below names both. Remembering a choice is one statement that locks the chosen bookmark `FOR KEY SHARE` and inserts the preference
// only if that bookmark is still a candidate for the account, so a bookmark that was deleted or made unreadable meanwhile is no preference, and a delete of
// the bookmark that follows waits for the transaction; choosing again for the slug replaces the bookmark.
//
// A preference is forgotten in two ways, both deleting the account's own row (the policy confines `slugbase_app` to it): the member forgets it (`forgetPreference`), and the
// resolution of the slug forgets one whose bookmark is stale (`forgetStale`): the bookmark has another slug, has stopped forwarding or can no longer be read by the account,
// which the deleting statement itself judges, so a choice made again or a bookmark restored in the meantime is kept. A plan-archived bookmark is not stale: it is ignored by the
// resolution and its choice comes back with the plan. The listing names the choices whose bookmark is a candidate of its slug, which is what the resolution would follow.

// `slugbase_app` may read the table, insert the four columns of a choice and update the bookmark of an existing choice. Defining the scoped repository enters its
// four methods in the registry the cross-tenant matrix runs against the table (doc 08 section 3.3); the product's write is the upsert in `remember`, which a
// scoped insert cannot express, and its reads and deletes are the statements below, which name the account as well as the workspace.
defineScopedRepository("slug_preferences", slugPreferences, {
  methods: ["select", "insert", "update", "delete"],
  insertColumns: ["accountId", "slug", "bookmarkId"],
  updateColumns: ["bookmarkId"],
});

export type GoRepository = GoStore & GoPreferenceStore & GoSuggestStore;

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

/** What `sys_go_suggest` answers, by the name of each column. */
type SuggestionRow = { id: string; slug: string; title: string; host: string; owner_id: string | null; owner_name: string | null; access: GoAccess };

/** The most suggestions `sys_go_suggest` answers. */
const SUGGEST_MAX = 10;

/** The columns of the candidates the predicate reads: `c` is the name the statement below gives them, and the workspace is the one of the transaction, given as a parameter. */
function candidateRow(workspaceId: string): SharableBookmarkRow {
  return { ownerId: sql.raw("c.owner_id"), id: sql.raw("c.id"), workspaceId: sql`${workspaceId}::uuid` };
}

/**
 * The candidate scan of doc 05 section 4, exported for the test that plans it: the candidates of the slug in the workspace, then the access predicate over
 * them (`bookmarkReadableBy`: its own, or shared with the account, doc 02 section 8). `access` is how the account reads the candidate: as its owner, or through the direct, team
 * or folder share that gives it. Needs a transaction opened with a workspace.
 */
export function candidatesStatement(tx: TenantTx, { slug, accountId }: { readonly slug: string; readonly accountId: string }): SQL {
  const workspaceId = requireWorkspace(tx, "resolving a slug");
  requireAccount(tx, accountId, "resolves a slug");
  const row = candidateRow(workspaceId);
  return sql`
    WITH candidates AS (
      SELECT ${bookmarks.id} AS id, ${bookmarks.ownerId} AS owner_id, ${bookmarks.url} AS url
      FROM ${bookmarks}
      WHERE ${bookmarks.workspaceId} = ${workspaceId}::uuid AND ${bookmarks.slug} = ${slug} AND ${bookmarks.forwarding} AND ${bookmarks.planArchivedAt} IS NULL
    )
    SELECT c.id, c.owner_id, c.url,
           ${bookmarkAccessOf(accountId, row)} AS access,
           (SELECT ${slugPreferences.bookmarkId} FROM ${slugPreferences}
            WHERE ${slugPreferences.workspaceId} = ${workspaceId}::uuid AND ${slugPreferences.accountId} = ${accountId}::uuid AND ${slugPreferences.slug} = ${slug}) AS preferred_id
    FROM candidates c
    WHERE ${bookmarkReadableBy(accountId, row)}`;
}

/** The go repository bound to the open transaction; every method needs a transaction opened with a workspace. */
export function goRepository(tx: TenantTx): GoRepository {
  return {
    async candidates({ slug, accountId }): Promise<GoCandidateSet> {
      const rows = await tenantHandle(tx).execute<CandidateRow>(candidatesStatement(tx, { slug, accountId }));
      const candidates = rows.map(({ id, owner_id: ownerId, url, access }) => ({ id, ownerId, url, access }));
      if (rows[0] !== undefined) {
        return { candidates, preferredId: rows[0].preferred_id ?? undefined };
      }
      // With no candidate the scan has no row to carry the choice, and a choice whose bookmark is gone from the slug is what the resolution forgets.
      const [remembered] = await tenantHandle(tx)
        .select({ bookmarkId: slugPreferences.bookmarkId })
        .from(slugPreferences)
        .where(and(eq(slugPreferences.workspaceId, requireWorkspace(tx, "resolving a slug")), eq(slugPreferences.accountId, accountId), eq(slugPreferences.slug, slug)));
      return { candidates, preferredId: remembered?.bookmarkId };
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

    async otherWorkspaces({ slug, accountId }): Promise<readonly GoWorkspace[]> {
      requireWorkspace(tx, "looking for a slug in other workspaces");
      requireAccount(tx, accountId, "looks for a slug in other workspaces");
      const rows = await tenantHandle(tx).execute<{ workspace_id: string; workspace_name: string }>(sql`SELECT workspace_id, workspace_name FROM sys_go_other_workspaces(${slug}::text)`);
      return rows.map((row) => ({ id: row.workspace_id, name: row.workspace_name }));
    },

    async suggest({ prefix, accountId, limit }): Promise<readonly GoSuggestionRecord[]> {
      requireWorkspace(tx, "suggesting slugs");
      requireAccount(tx, accountId, "asks for suggestions");
      if (!Number.isInteger(limit) || limit < 1 || limit > SUGGEST_MAX) {
        throw new Error(`suggesting slugs takes a whole limit from 1 to ${String(SUGGEST_MAX)}`);
      }
      const rows = await tenantHandle(tx).execute<SuggestionRow>(
        sql`SELECT id, slug, title, host, owner_id, owner_name, access FROM sys_go_suggest(${prefix}::text) ORDER BY access <> 'owner', slug COLLATE "C", id LIMIT ${limit}::integer`,
      );
      return rows.map((row) => ({ bookmarkId: row.id, slug: row.slug, title: row.title, host: row.host, ownerId: row.owner_id, ownerName: row.owner_name, access: row.access }));
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

    async forgetStale({ slug, bookmarkId, accountId }): Promise<boolean> {
      const workspaceId = requireWorkspace(tx, "forgetting a stale choice");
      requireAccount(tx, accountId, "forgets a stale choice");
      requireIdentifiers([bookmarkId], "forgetting a stale choice");
      const deleted = await tenantHandle(tx).execute<{ slug: string }>(sql`
        DELETE FROM ${slugPreferences}
        WHERE ${slugPreferences.workspaceId} = ${workspaceId}::uuid AND ${slugPreferences.accountId} = ${accountId}::uuid AND ${slugPreferences.slug} = ${slug}
          AND ${slugPreferences.bookmarkId} = ${bookmarkId}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM ${bookmarks}
            WHERE ${bookmarks.workspaceId} = ${workspaceId}::uuid AND ${bookmarks.id} = ${bookmarkId}::uuid AND ${bookmarks.slug} = ${slug}
              AND ${bookmarks.forwarding} AND ${bookmarkReadableBy(accountId)})
        RETURNING ${slugPreferences.slug}`);
      return deleted.length === 1;
    },

    async listPreferences({ accountId, afterSlug, limit }): Promise<readonly GoPreferenceRecord[]> {
      const workspaceId = requireWorkspace(tx, "listing the remembered choices");
      requireAccount(tx, accountId, "lists the remembered choices");
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("listing the remembered choices takes a positive whole limit");
      }
      // The slugs are ordered by bytes, so the keyset compares what the order sorts by whatever the collation of the database is.
      const bySlug = sql`${slugPreferences.slug} COLLATE "C"`;
      return tenantHandle(tx)
        .select({ slug: slugPreferences.slug, bookmarkId: bookmarks.id, title: bookmarks.title, host: bookmarks.host, ownerId: bookmarks.ownerId, ownerName: accounts.displayName })
        .from(slugPreferences)
        .innerJoin(
          bookmarks,
          and(
            eq(bookmarks.workspaceId, slugPreferences.workspaceId),
            eq(bookmarks.id, slugPreferences.bookmarkId),
            eq(bookmarks.slug, slugPreferences.slug),
            eq(bookmarks.forwarding, true),
            sql`${bookmarks.planArchivedAt} IS NULL`,
          ),
        )
        .leftJoin(accounts, eq(accounts.id, bookmarks.ownerId))
        .where(
          and(
            eq(slugPreferences.workspaceId, workspaceId),
            eq(slugPreferences.accountId, accountId),
            bookmarkReadableBy(accountId),
            afterSlug === undefined ? undefined : sql`${bySlug} > ${afterSlug} COLLATE "C"`,
          ),
        )
        .orderBy(asc(bySlug))
        .limit(limit);
    },

    async forgetPreference({ slug, accountId }): Promise<boolean> {
      const workspaceId = requireWorkspace(tx, "forgetting a choice");
      requireAccount(tx, accountId, "forgets a choice");
      const deleted = await tenantHandle(tx).execute<{ slug: string }>(sql`
        DELETE FROM ${slugPreferences}
        WHERE ${slugPreferences.workspaceId} = ${workspaceId}::uuid AND ${slugPreferences.accountId} = ${accountId}::uuid AND ${slugPreferences.slug} = ${slug}
        RETURNING ${slugPreferences.slug}`);
      return deleted.length === 1;
    },
  };
}
