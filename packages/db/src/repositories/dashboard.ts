import type { DashboardBookmark, DashboardSharedCounts, DashboardStore, DashboardSummary } from "@slugbase/core";
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { accounts } from "../schema/accounts.ts";
import { bookmarks } from "../schema/bookmarks.ts";
import { folderBookmarks, folders } from "../schema/folders.ts";
import { bookmarkShares, folderShares } from "../schema/shares.ts";
import { tags } from "../schema/tags.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { onboardingOf } from "./account-profile.ts";
import { bookmarkReadableBy, bookmarkSharedByOwner, sharedBookmarks } from "./bookmark-access.ts";

// The reads of the dashboard (doc 02 section 9.3, doc 04 section 10.8, doc 05 section 2.4, doc 10 T1 and T2) in the active workspace. Every statement names the workspace and the owner as
// well as the policy, and the owner is always the account of the transaction: a request that names another account is a programming error and throws. A plan-archived bookmark is neither
// counted nor listed. The quick access walks `bookmarks_owner_popular_idx` in the order of its key and stops at the limit, and the pinned bookmarks walk `bookmarks_pinned_idx`; the counts and
// the three facts of the checklist are one statement over the owner's keys. The count of bookmarks is read in the order of `bookmarks_owner_popular_idx` (the `OFFSET 0` keeps the order from
// being planned away), which makes an index-only walk of the owner's entries cheaper than any plan that must sort them; the two "has any" facts ask for the first row of an index in the order of
// that index (`bookmarks_owner_title_idx`, `bookmarks_owner_slug_key`) and, being scalar subqueries, are not rewritten into a test of existence that ignores the order. None of the three is a
// scan of the table, whatever the planner thinks of its statistics.
//
// The quick access also holds the forwarding bookmarks of other members that are shared with the account. They are driven from the set of the grants to the account (`sharedBookmarks`, the
// one rule of reading, doc 05 section 4) and probed by primary key, as the shared lists are, so the table is never scanned for them; the account's own bookmarks are the index walk above, and
// the two are merged at the limit. The sharing counts are read the same way: the bookmarks shared with the account are that set, and those the account shares are probed from the shares of the
// workspace and judged by `bookmarkSharedByOwner`, so both agree with the `shared_with_me` and `shared_by_me` scopes of the bookmark list.
//
// The top tags are the tag store's (`TagStore.list` sorted by count), which counts the bookmarks of a tag the way the tag list does.

const BOOKMARK_COLUMNS = {
  id: bookmarks.id,
  title: bookmarks.title,
  url: bookmarks.url,
  host: bookmarks.host,
  slug: bookmarks.slug,
  forwarding: bookmarks.forwarding,
  openCount: bookmarks.openCount,
};

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the dashboard needs a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

function requireOwner(tx: TenantTx, ownerId: string): string {
  if (ownerId.toLowerCase() !== tx.accountId) {
    throw new Error("the dashboard is read for the account of the transaction only");
  }
  return tx.accountId;
}

function requireLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("a dashboard list takes a positive whole limit");
  }
}

/** The statement of `DashboardRepository.summary`, exported for the test that plans it. Needs a transaction opened with a workspace, and the owner is the account of the transaction. */
export function summaryStatement(tx: TenantTx, ownerId: string): SQL {
  const workspaceId = requireWorkspace(tx);
  const owner = requireOwner(tx, ownerId);
  const own = sql`${bookmarks.workspaceId} = ${workspaceId}::uuid AND ${bookmarks.ownerId} = ${owner}::uuid`;
  return sql`
    SELECT
      (SELECT count(*) FROM (SELECT 1 FROM ${bookmarks} WHERE ${own} AND ${bookmarks.planArchivedAt} IS NULL ORDER BY ${bookmarks.openCount} DESC NULLS LAST, ${bookmarks.id} DESC NULLS LAST OFFSET 0) AS own_bookmarks)::int AS bookmarks,
      (SELECT count(*) FROM ${folders} WHERE ${folders.workspaceId} = ${workspaceId}::uuid AND ${folders.ownerId} = ${owner}::uuid)::int AS folders,
      (SELECT count(*) FROM ${tags} WHERE ${tags.workspaceId} = ${workspaceId}::uuid AND ${tags.ownerId} = ${owner}::uuid)::int AS tags,
      (SELECT 1 FROM ${bookmarks} WHERE ${own} ORDER BY lower(${bookmarks.title}), ${bookmarks.id} LIMIT 1) IS NOT NULL AS has_bookmark,
      (SELECT 1 FROM ${bookmarks} WHERE ${own} AND ${bookmarks.slug} IS NOT NULL ORDER BY ${bookmarks.slug} LIMIT 1) IS NOT NULL AS has_slug`;
}

/** The statement of `DashboardRepository.quickAccess`, exported for the test that plans it. */
export function quickAccessQuery(tx: TenantTx, ownerId: string, limit: number) {
  const workspaceId = requireWorkspace(tx);
  const owner = requireOwner(tx, ownerId);
  requireLimit(limit);
  // The caller's own bookmarks that it can read: the owner condition keeps the list the caller's own, and the readable rule (which also admits the bookmarks shared with the caller) is applied as well so that the rules of reading stay in one place.
  // A bookmark that forwards has a slug (`bookmarks_forwarding_check`), so the statement does not test the slug again: a second condition on a correlated column makes the planner
  // underestimate the matches, and with them the share of the index it has to walk, and it then prefers a scan of the table.
  return tenantHandle(tx)
    .select(BOOKMARK_COLUMNS)
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.workspaceId, workspaceId),
        eq(bookmarks.ownerId, owner),
        bookmarkReadableBy(owner),
        isNull(bookmarks.planArchivedAt),
        eq(bookmarks.forwarding, true),
      ),
    )
    .orderBy(sql`${bookmarks.openCount} DESC NULLS LAST`, sql`${bookmarks.id} DESC NULLS LAST`)
    .limit(limit);
}

/** The columns of `BOOKMARK_COLUMNS` as a raw statement reads them back. */
type SharedBookmarkRow = {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly host: string;
  readonly slug: string | null;
  readonly forwarding: boolean;
  readonly open_count: number | string;
};

/**
 * The statement of the shared part of `DashboardRepository.quickAccess`, exported for the test that plans it: the forwarding bookmarks of other members that are shared with the account, not
 * plan-archived, the most opened first, driven from the grants to the account.
 */
export function sharedQuickAccessStatement(tx: TenantTx, ownerId: string, limit: number): SQL {
  const workspaceId = requireWorkspace(tx);
  const owner = requireOwner(tx, ownerId);
  requireLimit(limit);
  return sql`
    WITH shared AS MATERIALIZED (${sharedBookmarks(owner, workspaceId)})
    SELECT probed.id, probed.title, probed.url, probed.host, probed.slug, probed.forwarding, probed.open_count
    FROM shared
    CROSS JOIN LATERAL (
      SELECT ${bookmarks.id} AS id, ${bookmarks.title} AS title, ${bookmarks.url} AS url, ${bookmarks.host} AS host, ${bookmarks.slug} AS slug, ${bookmarks.forwarding} AS forwarding, ${bookmarks.openCount} AS open_count
      FROM ${bookmarks}
      WHERE ${bookmarks.id} = shared.bookmark_id AND ${bookmarks.workspaceId} = ${workspaceId}::uuid AND ${bookmarks.ownerId} IS DISTINCT FROM ${owner}::uuid
        AND ${bookmarks.planArchivedAt} IS NULL AND ${bookmarks.forwarding} = true
      OFFSET 0) probed
    ORDER BY probed.open_count DESC NULLS LAST, probed.id DESC NULLS LAST
    LIMIT ${limit}::integer`;
}

/**
 * The statement of `DashboardRepository.sharedCounts`, exported for the test that plans it. The bookmarks shared with the account are the set of its grants, of which the ones another member
 * owns and that are not plan-archived are counted. The account's own bookmarks that are shared are probed from the shares of the workspace (a bookmark shared directly, and the bookmarks filed
 * in a folder that has a share) and kept only if `bookmarkSharedByOwner` says so, so the shares are the way to the rows and the rule of that predicate decides.
 */
export function sharedCountsStatement(tx: TenantTx, ownerId: string): SQL {
  const workspaceId = requireWorkspace(tx);
  const owner = requireOwner(tx, ownerId);
  return sql`
    WITH shared AS MATERIALIZED (${sharedBookmarks(owner, workspaceId)}),
         shares_in_workspace AS MATERIALIZED (
           SELECT bs.bookmark_id FROM ${bookmarkShares} bs WHERE bs.workspace_id = ${workspaceId}::uuid
           UNION
           SELECT fb.bookmark_id FROM ${folderShares} fs JOIN ${folderBookmarks} fb ON fb.workspace_id = fs.workspace_id AND fb.folder_id = fs.folder_id WHERE fs.workspace_id = ${workspaceId}::uuid)
    SELECT
      (SELECT count(*) FROM shared CROSS JOIN LATERAL (
         SELECT 1 FROM ${bookmarks}
         WHERE ${bookmarks.id} = shared.bookmark_id AND ${bookmarks.workspaceId} = ${workspaceId}::uuid AND ${bookmarks.ownerId} IS DISTINCT FROM ${owner}::uuid AND ${bookmarks.planArchivedAt} IS NULL
         OFFSET 0) probed)::int AS shared_with_you,
      (SELECT count(*) FROM shares_in_workspace CROSS JOIN LATERAL (
         SELECT 1 FROM ${bookmarks}
         WHERE ${bookmarks.id} = shares_in_workspace.bookmark_id AND ${bookmarks.workspaceId} = ${workspaceId}::uuid AND ${bookmarks.ownerId} = ${owner}::uuid AND ${bookmarks.planArchivedAt} IS NULL
           AND ${bookmarkSharedByOwner()}
         OFFSET 0) probed)::int AS shared_by_you`;
}

/** The statement of `DashboardRepository.pinned`, exported for the test that plans it. */
export function pinnedQuery(tx: TenantTx, ownerId: string, limit: number) {
  const workspaceId = requireWorkspace(tx);
  const owner = requireOwner(tx, ownerId);
  requireLimit(limit);
  return tenantHandle(tx)
    .select(BOOKMARK_COLUMNS)
    .from(bookmarks)
    .where(and(eq(bookmarks.workspaceId, workspaceId), eq(bookmarks.ownerId, owner), isNotNull(bookmarks.pinnedAt), isNull(bookmarks.planArchivedAt)))
    .orderBy(desc(bookmarks.pinnedAt), desc(bookmarks.id))
    .limit(limit);
}

export type DashboardRepository = DashboardStore;

/** The reads of the dashboard bound to the open transaction; every method needs a transaction opened with a workspace. */
export function dashboardRepository(tx: TenantTx): DashboardRepository {
  return {
    async summary(ownerId): Promise<DashboardSummary> {
      const [row] = await tenantHandle(tx).execute<{ bookmarks: number; folders: number; tags: number; has_bookmark: boolean; has_slug: boolean }>(summaryStatement(tx, ownerId));
      if (row === undefined) {
        throw new Error("counting the dashboard returned no row");
      }
      return { bookmarks: row.bookmarks, folders: row.folders, tags: row.tags, hasBookmark: row.has_bookmark, hasSlug: row.has_slug };
    },

    async quickAccess(ownerId, limit): Promise<readonly DashboardBookmark[]> {
      // One after the other: the statements share the one connection of the transaction. The two parts are disjoint (a shared bookmark is another member's), so their merge holds none twice.
      const own = await quickAccessQuery(tx, ownerId, limit);
      const shared = await tenantHandle(tx).execute<SharedBookmarkRow>(sharedQuickAccessStatement(tx, ownerId, limit));
      const sharedEntries = shared.map((row): DashboardBookmark => ({ id: row.id, title: row.title, url: row.url, host: row.host, slug: row.slug, forwarding: row.forwarding, openCount: Number(row.open_count) }));
      return [...own, ...sharedEntries].sort((a, b) => b.openCount - a.openCount || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, limit);
    },

    async sharedCounts(ownerId): Promise<DashboardSharedCounts> {
      const [row] = await tenantHandle(tx).execute<{ shared_with_you: number; shared_by_you: number }>(sharedCountsStatement(tx, ownerId));
      if (row === undefined) {
        throw new Error("counting the shared bookmarks returned no row");
      }
      return { sharedWithYou: row.shared_with_you, sharedByYou: row.shared_by_you };
    },

    async pinned(ownerId, limit): Promise<readonly DashboardBookmark[]> {
      return pinnedQuery(tx, ownerId, limit);
    },

    async onboarding(ownerId) {
      const owner = requireOwner(tx, ownerId);
      const [row] = await tenantHandle(tx).select({ onboarding: accounts.onboarding }).from(accounts).where(eq(accounts.id, owner));
      return row === undefined ? undefined : onboardingOf(row.onboarding);
    },
  };
}
