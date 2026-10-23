import {
  createAuditWriter,
  type BookmarkArchiveTransaction,
  type BookmarkListFilter,
  type BookmarkListRequest,
  type BookmarkListRow,
  type BookmarkRecord,
  type BookmarkSort,
  type BookmarkUpdateRequest,
  type BookmarkUpdateResult,
  type NewBookmark,
} from "@slugbase/core";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { auditEventRepository } from "./audit-events.ts";
import { entitlementRepository } from "./entitlements.ts";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { defineScopedRepository } from "./scoped.ts";

// The bookmarks of the active workspace (doc 05 section 2.4, doc 02 section 5, doc 10 T1, T2 and T11). Reads, the insert and the
// update go through the scoped repository below, so every statement carries the workspace of the transaction and runs on the
// policies of `bookmarks` on top of that; `slugbase_app` may not delete a row, which is why the repository has no `delete`. A
// bookmark that is plan-archived is not one the product shows or edits, so a lookup and an update leave it out; its owner may still
// delete it. Changing and deleting a bookmark are its owner's: both name the owner in the statement, so another member's bookmark
// is a row the statement does not find. A delete is the system operation `sys_bookmark_delete`, which removes the row and gives
// its place under `bookmarks.max` back in the same statement of the transaction, so the counter and the rows cannot part. The place under
// `bookmarks.max` is taken by the system operation `sys_bookmark_count_take`, which locks the workspace's row, compares the
// workspace's `bookmark_count` with the ceiling and raises it, in the transaction that inserts the bookmark: a failed
// insert takes the place back with it, and two creations at the limit minus one make one. Archiving and restoring are the system
// operation `sys_bookmark_archive_set`, which sets or clears `plan_archived_at` for the given bookmarks, moves the counter by the rows
// that changed, in one call, because `slugbase_app` may write neither column; the `entitlement_version` is raised separately, through
// `sys_workspace_bump_entitlement_version` (`withEntitlementChange`, doc 01 section 7.5). A list is one owner's bookmarks of the
// workspace in one of six orderings, resumed by a keyset: the sort key of the last row and its identifier, compared as a row, so
// the statement is a range scan of the index that serves the sort (doc 05 section 2.4) and the page costs the same at any depth.
// The sort keys are read back as text and passed back as text, because a timestamp the driver turns into a `Date` loses the
// microseconds the database keeps, and a row that shares its key with the cursor's would then be skipped or repeated.

// `slugbase_app` may insert only the columns a request gives a new bookmark and update only the columns a change of its own fields
// writes (src/sql/470-bookmarks.sql): not the slug, forwarding, the archive state, the usage, the owner or the version, so a row
// it writes is never archived or forwarding and starts unused, and its version is moved by the trigger and by nothing it sends.
const scoped = defineScopedRepository("bookmarks", bookmarks, {
  methods: ["select", "insert", "update"],
  insertColumns: ["id", "ownerId", "url", "urlCanonical", "host", "title", "description", "pinnedAt"],
  updateColumns: ["url", "urlCanonical", "host", "title", "description", "pinnedAt"],
});

type BookmarkRow = InferSelectModel<typeof bookmarks>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TakenRow extends Record<string, unknown> {
  outcome: string;
  used: number | null;
}

interface DeletedRow extends Record<string, unknown> {
  deleted: boolean | null;
}

interface ArchivedRow extends Record<string, unknown> {
  changed: number | null;
}

export interface BookmarkCreation {
  readonly bookmark: NewBookmark;
  /** The workspace's `bookmarks.max`: the most bookmarks it may hold, null for no ceiling. Judged under the lock of the workspace's row. */
  readonly ceiling: number | null;
  /** Jobs queued in the same transaction, only when the bookmark is created. */
  readonly jobs: readonly QueuedJob[];
}

export type BookmarkCreationResult =
  | { readonly kind: "created"; readonly bookmark: BookmarkRecord }
  /** The workspace holds `used` bookmarks, which is as many as the ceiling allows. */
  | { readonly kind: "limit_reached"; readonly used: number }
  /** The workspace of the transaction cannot be reached: it is being deleted, or the account is no member of it. */
  | { readonly kind: "unavailable" };

export interface BookmarkRepository {
  /**
   * Takes one place under the ceiling, inserts the bookmark and queues the jobs, in the open transaction. Nothing is written
   * for `limit_reached` and `unavailable`. Needs a transaction opened with a workspace.
   */
  create(creation: BookmarkCreation): Promise<BookmarkCreationResult>;
  /**
   * The bookmark of the workspace of the transaction with that identifier, whoever owns it; undefined when there is none or it
   * is plan-archived. Needs a transaction opened with a workspace.
   */
  find(bookmarkId: string): Promise<BookmarkRecord | undefined>;
  /**
   * Changes the bookmark that `ownerId` owns in the workspace of the transaction, unless it is plan-archived. The row is locked
   * first; when `expectedVersions` is given and the version under the lock is none of them the answer is `stale` and nothing is
   * written, and a patch that names the values the row has is `unchanged`. A change moves the version by one (the trigger
   * `bookmarks_bump_version`). Needs a transaction opened with a workspace.
   */
  update(request: BookmarkUpdateRequest): Promise<BookmarkUpdateResult>;
  /**
   * Deletes the bookmark that `ownerId` owns in the workspace of the transaction, a plan-archived one included, and answers
   * whether there was one, through `sys_bookmark_delete`: the workspace's `bookmark_count` falls by one with the row unless the
   * bookmark was plan-archived. `ownerId` is the account of the transaction, which is the owner the function reads from the
   * session; another account is a programming error. Needs a transaction opened with a workspace.
   */
  remove(request: { readonly bookmarkId: string; readonly ownerId: string }): Promise<boolean>;
  /**
   * Sets or clears `plan_archived_at` of the given bookmarks of the workspace of the transaction through
   * `sys_bookmark_archive_set`, whoever owns them, and answers how many rows changed; the workspace's `bookmark_count` moves by
   * that number in the same call. The `entitlement_version` does not move here: that is `entitlementRepository(tx).bump()`. An
   * identifier that names no bookmark of the workspace is skipped. Undefined, writing nothing, when the workspace cannot be
   * reached. Needs a transaction opened with a workspace.
   */
  setArchived(request: { readonly bookmarkIds: readonly string[]; readonly archived: boolean }): Promise<number | undefined>;
  /**
   * The bookmarks that `request.filter.ownerId` owns in the workspace of the transaction and that are not plan-archived, in the order
   * of `request.sort` with the identifier as the tiebreak, starting after `request.after` and at most `request.limit` of them; each
   * comes with its sort key as text, which a later call passes back in `after`. A never-opened bookmark sorts last under
   * `recently_opened`. Needs a transaction opened with a workspace.
   */
  list(request: BookmarkListRequest): Promise<readonly BookmarkListRow[]>;
  /**
   * How many bookmarks the same filter matches, counting no further than `limit`: the cost of the answer is bounded by `limit`, not by
   * the size of the library. Needs a transaction opened with a workspace.
   */
  count(filter: BookmarkListFilter, limit: number): Promise<number>;
}

/** The predicate of a list and of its count: the workspace, the owner, never a plan-archived bookmark, and the filters given. */
function listPredicate(workspaceId: string, filter: BookmarkListFilter): SQL {
  const predicate = and(
    eq(bookmarks.workspaceId, workspaceId),
    eq(bookmarks.ownerId, filter.ownerId),
    isNull(bookmarks.planArchivedAt),
    filter.pinned === undefined ? undefined : filter.pinned ? isNotNull(bookmarks.pinnedAt) : isNull(bookmarks.pinnedAt),
    filter.hasSlug === undefined ? undefined : filter.hasSlug ? isNotNull(bookmarks.slug) : isNull(bookmarks.slug),
    filter.forwarding === undefined ? undefined : eq(bookmarks.forwarding, filter.forwarding),
    filter.urlCanonical === undefined ? undefined : eq(bookmarks.urlCanonical, filter.urlCanonical),
  );
  if (predicate === undefined) {
    throw new Error("a list predicate is never empty");
  }
  return predicate;
}

/** The rows after the cursor's place, compared as a row so the index serves the range. A never-opened bookmark is last, after every opened one. */
function afterPosition(sort: BookmarkSort, after: { readonly key: string | null; readonly id: string }): SQL {
  const { column, cast, direction } = SORT_ORDERS[sort];
  const op = sql.raw(direction);
  if (sort === "recently_opened") {
    if (after.key === null) {
      return sql`(${column} IS NULL AND ${bookmarks.id} < ${after.id}::uuid)`;
    }
    return sql`((${column}, ${bookmarks.id}) < (${after.key}::timestamptz, ${after.id}::uuid) OR ${column} IS NULL)`;
  }
  if (after.key === null) {
    throw new Error("a cursor of this sort carries a sort key");
  }
  return sql`((${column}, ${bookmarks.id}) ${op} (${after.key}::${sql.raw(cast)}, ${after.id}::uuid))`;
}

/** The columns a bookmark record is made of; `search` and `url_canonical` are read by the database only. */
type BookmarkRecordRow = Pick<
  BookmarkRow,
  "id" | "ownerId" | "url" | "host" | "title" | "description" | "slug" | "forwarding" | "pinnedAt" | "openCount" | "lastOpenedAt" | "version" | "createdAt" | "updatedAt"
>;

const RECORD_COLUMNS = {
  id: bookmarks.id,
  ownerId: bookmarks.ownerId,
  url: bookmarks.url,
  host: bookmarks.host,
  title: bookmarks.title,
  description: bookmarks.description,
  slug: bookmarks.slug,
  forwarding: bookmarks.forwarding,
  pinnedAt: bookmarks.pinnedAt,
  openCount: bookmarks.openCount,
  lastOpenedAt: bookmarks.lastOpenedAt,
  version: bookmarks.version,
  createdAt: bookmarks.createdAt,
  updatedAt: bookmarks.updatedAt,
} as const;

// The ordering of each sort, written the way its index is declared (`DESC NULLS LAST` for the descending ones, which is what
// drizzle-kit writes for `desc()`), so the planner reads the index in order instead of sorting; an ascending sort of a
// descending index reads it backwards, which turns `NULLS LAST` into `NULLS FIRST`. `key` is the sort key as text, `cast` the type
// it is read back as and `after` the comparison that selects the rows after the cursor's.
interface SortOrder {
  /** The expression the index orders by. */
  readonly column: SQL;
  readonly key: SQL;
  readonly cast: "timestamptz" | "text" | "bigint";
  readonly order: SQL;
  readonly direction: "<" | ">";
}

const SORT_ORDERS: Readonly<Record<BookmarkSort, SortOrder>> = {
  recent: { column: sql`${bookmarks.createdAt}`, key: sql`${bookmarks.createdAt}::text`, cast: "timestamptz", order: sql`${bookmarks.createdAt} DESC NULLS LAST, ${bookmarks.id} DESC NULLS LAST`, direction: "<" },
  oldest: { column: sql`${bookmarks.createdAt}`, key: sql`${bookmarks.createdAt}::text`, cast: "timestamptz", order: sql`${bookmarks.createdAt} ASC NULLS FIRST, ${bookmarks.id} ASC NULLS FIRST`, direction: ">" },
  title_asc: { column: sql`lower(${bookmarks.title})`, key: sql`lower(${bookmarks.title})`, cast: "text", order: sql`lower(${bookmarks.title}) ASC NULLS LAST, ${bookmarks.id} ASC NULLS LAST`, direction: ">" },
  title_desc: { column: sql`lower(${bookmarks.title})`, key: sql`lower(${bookmarks.title})`, cast: "text", order: sql`lower(${bookmarks.title}) DESC NULLS FIRST, ${bookmarks.id} DESC NULLS FIRST`, direction: "<" },
  most_used: { column: sql`${bookmarks.openCount}`, key: sql`${bookmarks.openCount}::text`, cast: "bigint", order: sql`${bookmarks.openCount} DESC NULLS LAST, ${bookmarks.id} DESC NULLS LAST`, direction: "<" },
  recently_opened: { column: sql`${bookmarks.lastOpenedAt}`, key: sql`${bookmarks.lastOpenedAt}::text`, cast: "timestamptz", order: sql`${bookmarks.lastOpenedAt} DESC NULLS LAST, ${bookmarks.id} DESC NULLS LAST`, direction: "<" },
};

function recordOf(row: BookmarkRecordRow): BookmarkRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    url: row.url,
    host: row.host,
    title: row.title,
    description: row.description,
    slug: row.slug,
    forwarding: row.forwarding,
    pinned: row.pinnedAt !== null,
    openCount: row.openCount,
    lastOpenedAt: row.lastOpenedAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The statement of `BookmarkRepository.list`, exported for the test that plans it. Needs a transaction opened with a workspace. */
export function listQuery(tx: TenantTx, { filter, sort, after, limit }: BookmarkListRequest) {
  const workspaceId = requireListWorkspace(tx, "listing bookmarks");
  const { key, order } = SORT_ORDERS[sort];
  const predicate = after === undefined ? listPredicate(workspaceId, filter) : and(listPredicate(workspaceId, filter), afterPosition(sort, after));
  return tenantHandle(tx)
    .select({ ...RECORD_COLUMNS, sortKey: sql<string | null>`${key}`.as("sort_key") })
    .from(bookmarks)
    .where(predicate)
    .orderBy(order)
    .limit(limit);
}

/** The statement of `BookmarkRepository.count`, exported for the test that plans it. Needs a transaction opened with a workspace. */
export function countQuery(tx: TenantTx, filter: BookmarkListFilter, limit: number) {
  const workspaceId = requireListWorkspace(tx, "counting bookmarks");
  const handle = tenantHandle(tx);
  const capped = handle.select({ one: sql<number>`1`.as("one") }).from(bookmarks).where(listPredicate(workspaceId, filter)).limit(limit).as("capped");
  return handle.select({ total: sql<number>`count(*)::int` }).from(capped);
}

function requireListWorkspace(tx: TenantTx, action: string): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", `${action} needs a tenant transaction opened with a workspace`);
  }
  return tx.workspaceId;
}

export function bookmarkRepository(tx: TenantTx): BookmarkRepository {
  const rows = scoped.bind(tx);
  return {
    async create({ bookmark, ceiling, jobs }) {
      if (tx.workspaceId === undefined) {
        throw new TenantContextError("workspace_required", "creating a bookmark needs a tenant transaction opened with a workspace");
      }
      const taken = await tenantHandle(tx).execute<TakenRow>(sql`
        SELECT outcome, used FROM public.sys_bookmark_count_take(${tx.workspaceId}::uuid, ${ceiling}::integer)`);
      const row = taken[0];
      if (taken.length !== 1 || row === undefined) {
        throw new Error("sys_bookmark_count_take did not return exactly one row");
      }
      if (row.outcome === "unavailable") {
        return { kind: "unavailable" };
      }
      if (row.outcome === "limit_reached") {
        // The count the function judged the refusal against, returned with the outcome.
        if (row.used === null) {
          throw new Error("sys_bookmark_count_take refused without the count it judged");
        }
        return { kind: "limit_reached", used: row.used };
      }
      if (row.outcome !== "taken") {
        throw new Error("sys_bookmark_count_take returned an outcome outside taken, limit_reached and unavailable");
      }
      const stored = await rows.insert({
        id: bookmark.id,
        ownerId: bookmark.ownerId,
        url: bookmark.url,
        urlCanonical: bookmark.urlCanonical,
        host: bookmark.host,
        title: bookmark.title,
        description: bookmark.description,
        pinnedAt: bookmark.pinned ? new Date() : null,
      });
      for (const job of jobs) {
        await enqueueInTenantTransaction(tx, job);
      }
      return { kind: "created", bookmark: recordOf(stored) };
    },

    async find(bookmarkId) {
      const [row] = await rows.select(and(eq(bookmarks.id, bookmarkId), isNull(bookmarks.planArchivedAt)));
      return row === undefined ? undefined : recordOf(row);
    },

    async update({ bookmarkId, ownerId, changes, expectedVersions }) {
      if (tx.workspaceId === undefined) {
        throw new TenantContextError("workspace_required", "changing a bookmark needs a tenant transaction opened with a workspace");
      }
      const [current] = await tenantHandle(tx)
        .select()
        .from(bookmarks)
        .where(and(eq(bookmarks.workspaceId, tx.workspaceId), eq(bookmarks.id, bookmarkId), eq(bookmarks.ownerId, ownerId), isNull(bookmarks.planArchivedAt)))
        .for("update");
      if (current === undefined) {
        return { kind: "not_found" };
      }
      if (expectedVersions !== undefined && !expectedVersions.includes(current.version)) {
        return { kind: "stale" };
      }
      const set: Parameters<typeof rows.update>[0] = {};
      if (changes.url !== undefined && (changes.url.url !== current.url || changes.url.canonical !== current.urlCanonical || changes.url.host !== current.host)) {
        set.url = changes.url.url;
        set.urlCanonical = changes.url.canonical;
        set.host = changes.url.host;
      }
      if (changes.title !== undefined && changes.title !== current.title) {
        set.title = changes.title;
      }
      if (changes.description !== undefined && changes.description !== current.description) {
        set.description = changes.description;
      }
      if (changes.pinned !== undefined && changes.pinned !== (current.pinnedAt !== null)) {
        set.pinnedAt = changes.pinned ? new Date() : null;
      }
      if (Object.keys(set).length === 0) {
        return { kind: "unchanged", bookmark: recordOf(current) };
      }
      const [updated] = await rows.update(set, eq(bookmarks.id, bookmarkId));
      if (updated === undefined) {
        throw new Error("changing a locked bookmark did not update exactly one row");
      }
      return { kind: "updated", bookmark: recordOf(updated) };
    },

    async remove({ bookmarkId, ownerId }) {
      if (tx.workspaceId === undefined) {
        throw new TenantContextError("workspace_required", "deleting a bookmark needs a tenant transaction opened with a workspace");
      }
      if (ownerId.toLowerCase() !== tx.accountId.toLowerCase()) {
        throw new Error("only the account of the transaction deletes its own bookmark");
      }
      const deleted = await tenantHandle(tx).execute<DeletedRow>(sql`
        SELECT public.sys_bookmark_delete(${tx.workspaceId}::uuid, ${bookmarkId}::uuid) AS deleted`);
      const row = deleted[0];
      if (deleted.length !== 1 || row === undefined || typeof row.deleted !== "boolean") {
        throw new Error("sys_bookmark_delete did not return exactly one answer");
      }
      return row.deleted;
    },

    async setArchived({ bookmarkIds, archived }) {
      if (tx.workspaceId === undefined) {
        throw new TenantContextError("workspace_required", "archiving bookmarks needs a tenant transaction opened with a workspace");
      }
      if (!bookmarkIds.every((id) => UUID.test(id))) {
        throw new Error("archiving bookmarks takes identifiers only");
      }
      // One parameter, whatever the number of identifiers: a PostgreSQL array literal of UUIDs, which hold no character it would need to quote.
      const changed = await tenantHandle(tx).execute<ArchivedRow>(sql`
        SELECT public.sys_bookmark_archive_set(${tx.workspaceId}::uuid, ${`{${bookmarkIds.join(",")}}`}::uuid[], ${archived}::boolean) AS changed`);
      const row = changed[0];
      if (changed.length !== 1 || row === undefined) {
        throw new Error("sys_bookmark_archive_set did not return exactly one answer");
      }
      return row.changed ?? undefined;
    },

    async list(request) {
      const found = await listQuery(tx, request);
      return found.map(({ sortKey, ...row }) => ({ bookmark: recordOf(row), key: sortKey }));
    },

    async count(filter, limit) {
      const [row] = await countQuery(tx, filter, limit);
      if (row === undefined) {
        throw new Error("counting bookmarks returned no row");
      }
      return row.total;
    },
  };
}

/**
 * The transaction as `archiveBookmarks` and `restoreBookmarks` of `@slugbase/core` use it: the bookmarks repository, the entitlement
 * version writer and the audit writer of the same open transaction, so the archive state, the counter, the entitlement version and
 * the event commit or roll back together. `newId` is a fresh UUIDv7.
 */
export function bookmarkArchiveTransaction(tx: TenantTx, newId: () => string): BookmarkArchiveTransaction {
  const repository = bookmarkRepository(tx);
  const entitlements = entitlementRepository(tx);
  return {
    workspaceId: tx.workspaceId,
    setArchived: (request) => repository.setArchived(request),
    entitlementVersion: { bump: () => entitlements.bump() },
    audit: createAuditWriter({ store: auditEventRepository(tx), newId }),
  };
}
