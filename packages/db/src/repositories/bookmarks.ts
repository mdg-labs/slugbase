import {
  createAuditWriter,
  type BookmarkArchiveTransaction,
  type BookmarkFolderRef,
  type BookmarkTagRef,
  type BookmarkTagSelection,
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
import { folderBookmarks, folders } from "../schema/folders.ts";
import { bookmarkTags, tags } from "../schema/tags.ts";
import { auditEventRepository } from "./audit-events.ts";
import { entitlementRepository } from "./entitlements.ts";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { deleteLinks, distinctIdentifiers, foldersOfBookmarks, insertLinks, lockOwnedFolders, requireIdentifiers, uuidArray } from "./folder-links.ts";
import { defineScopedRepository } from "./scoped.ts";
import { deleteTagLinks, insertTagLinks, lockTaggingTags, ownedTagsExist, resolveTagNames, tagsOfBookmarks } from "./tag-links.ts";

// The bookmarks of the active workspace (doc 05 section 2.4, doc 02 section 5, doc 10 T1, T2 and T11). Reads, the insert and the
// update go through the scoped repository below, so every statement carries the workspace of the transaction and runs on the
// policies of `bookmarks` on top of that; `slugbase_app` may not delete a row, which is why the repository has no `delete`. A
// bookmark that is plan-archived is not one the product shows or edits, so a lookup and an update leave it out; its owner may still
// delete it. Changing and deleting a bookmark are its owner's: both name the owner in the statement, so another member's bookmark
// is a row the statement does not find. A delete is the system operation `sys_bookmark_delete`, which removes the row and gives
// its place under `bookmarks.max` back in the same statement of the transaction, so the counter and the rows cannot part; a bulk delete is `sys_bookmark_delete_many`, which lowers the counter once for all the rows it deletes. A bulk pin or unpin locks the caller's rows in identifier order and writes the pin of those not in the wanted state. The place under
// `bookmarks.max` is taken by the system operation `sys_bookmark_count_take`, which locks the workspace's row, compares the
// workspace's `bookmark_count` with the ceiling and raises it, in the transaction that inserts the bookmark: a failed
// insert takes the place back with it, and two creations at the limit minus one make one. Archiving and restoring are the system
// operation `sys_bookmark_archive_set`, which sets or clears `plan_archived_at` for the given bookmarks, moves the counter by the rows
// that changed, in one call, because `slugbase_app` may write neither column; the `entitlement_version` is raised separately, through
// `sys_workspace_bump_entitlement_version` (`withEntitlementChange`, doc 01 section 7.5). A list is one owner's bookmarks of the
// workspace in one of six orderings, resumed by a keyset: the sort key of the last row and its identifier, compared as a row, so
// the statement is a range scan of the index that serves the sort (doc 05 section 2.4) and the page costs the same at any depth.
// The sort keys are read back as text and passed back as text, because a timestamp the driver turns into a `Date` loses the
// microseconds the database keeps, and a row that shares its key with the cursor's would then be skipped or repeated. A bookmark is filed in
// the folders of its owner in the same transaction that creates or changes it (`folderIds`), through the links of src/repositories/folder-links.ts;
// the folders are locked and checked before the first write, so a folder that is not the owner's ends the call with nothing written, and every
// record carries the folders it is filed in. A list may be narrowed to one folder of the caller's, which an EXISTS over the links of the
// bookmark answers by the primary key of `folder_bookmarks`, `(folder_id, bookmark_id)`; the index on `(workspace_id, bookmark_id)`
// serves the read of the folders of the bookmarks of a page. A bookmark carries the tags of its owner in the same way (`tagIds` and `tagNames`
// of a creation and `tags` of a change, through src/repositories/tag-links.ts): tags named by identifier are checked before the first write, a name
// the owner has no tag of creates one in the transaction, and every record carries the tags of the caller only. A list may be narrowed to the
// bookmarks that carry every one of several tags of the caller's (AND), one EXISTS over the links for each tag, which the primary key of
// `bookmark_tags`, `(bookmark_id, tag_id)`, answers for the bookmark in hand.

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

interface DeletedManyRow extends Record<string, unknown> {
  deleted: number | null;
}

export interface BookmarkCreation {
  readonly bookmark: NewBookmark;
  /** The workspace's `bookmarks.max`: the most bookmarks it may hold, null for no ceiling. Judged under the lock of the workspace's row. */
  readonly ceiling: number | null;
  /** Jobs queued in the same transaction, only when the bookmark is created. */
  readonly jobs: readonly QueuedJob[];
  /** The owner's folders the bookmark is filed in; none when left out. */
  readonly folderIds?: readonly string[];
  /** The owner's tags the bookmark carries, by identifier and by name; none when left out. */
  readonly tags?: BookmarkTagSelection;
}

export type BookmarkCreationResult =
  | { readonly kind: "created"; readonly bookmark: BookmarkRecord }
  /** The workspace holds `used` bookmarks, which is as many as the ceiling allows. */
  | { readonly kind: "limit_reached"; readonly used: number }
  /** The workspace of the transaction cannot be reached: it is being deleted, or the account is no member of it. */
  | { readonly kind: "unavailable" }
  /** A folder is not one the owner has in the workspace; nothing is written. */
  | { readonly kind: "folder_not_found" }
  /** A tag named by identifier is not one the owner has in the workspace; nothing is written. */
  | { readonly kind: "tag_not_found" };

export interface BookmarkRepository {
  /**
   * Takes one place under the ceiling, inserts the bookmark, files it in the folders and queues the jobs, in the open transaction. Nothing
   * is written for `limit_reached`, `unavailable`, `folder_not_found` and `tag_not_found`. The bookmark is tagged in the same transaction, and a name
   * of `tags` that the owner has no tag of creates one. Needs a transaction opened with a workspace.
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
   * written, and a patch that names the values the row has, in the folders it is in, is `unchanged`. `changes.folderIds` replaces the
   * owner's folders the bookmark is filed in, and `changes.tags` the owner's tags it carries; a folder or a tag that is not the owner's is
   * `folder_not_found` or `tag_not_found` with nothing written, and a name of `changes.tags` that the owner has no tag of creates one. A change
   * of the row's own columns moves the version by one (the trigger
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
   * Deletes the bookmarks of `bookmarkIds` that the account of the transaction owns in the workspace of the transaction, a plan-archived one
   * included, through `sys_bookmark_delete_many`, and answers how many were deleted; the workspace's `bookmark_count` falls once, by those
   * that were not plan-archived, in the same call. An identifier that names no such bookmark is skipped. Undefined, writing nothing, when
   * the workspace cannot be reached. Needs a transaction opened with a workspace.
   */
  removeMany(request: { readonly bookmarkIds: readonly string[] }): Promise<number | undefined>;
  /**
   * Pins (`pinned`) or unpins the bookmarks of `bookmarkIds` that `ownerId` owns in the workspace of the transaction and that are not
   * plan-archived, and answers how many such bookmarks there are. The rows are locked in the order of their identifiers first; only those
   * not in the wanted state are written, so one that is keeps its pin time and its version. `ownerId` is the account of the transaction.
   * Needs a transaction opened with a workspace.
   */
  setPinned(request: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly pinned: boolean }): Promise<number>;
  /**
   * The identifiers of the bookmarks that `filter.ownerId` owns in the workspace of the transaction and that match the filter, newest
   * first and without the plan-archived ones, at most `limit`. Needs a transaction opened with a workspace.
   */
  ids(filter: BookmarkListFilter, limit: number): Promise<readonly string[]>;
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

/** The bookmark is filed in the folder `folderId`, and the folder is its owner's: a folder of another member matches nothing. */
function filedIn(folderId: string): SQL {
  requireIdentifiers([folderId], "listing the bookmarks of a folder");
  return sql`EXISTS (
    SELECT 1 FROM ${folderBookmarks} INNER JOIN ${folders} ON ${folders.workspaceId} = ${folderBookmarks.workspaceId} AND ${folders.id} = ${folderBookmarks.folderId}
    WHERE ${folderBookmarks.workspaceId} = ${bookmarks.workspaceId} AND ${folderBookmarks.bookmarkId} = ${bookmarks.id} AND ${folderBookmarks.folderId} = ${folderId}::uuid AND ${folders.ownerId} = ${bookmarks.ownerId})`;
}

/** The bookmark carries the tag `tagId`, and the tag is its owner's: a tag of another member matches nothing. */
function tagged(tagId: string): SQL {
  requireIdentifiers([tagId], "listing the bookmarks of a tag");
  return sql`EXISTS (
    SELECT 1 FROM ${bookmarkTags} INNER JOIN ${tags} ON ${tags.workspaceId} = ${bookmarkTags.workspaceId} AND ${tags.id} = ${bookmarkTags.tagId}
    WHERE ${bookmarkTags.workspaceId} = ${bookmarks.workspaceId} AND ${bookmarkTags.bookmarkId} = ${bookmarks.id} AND ${bookmarkTags.tagId} = ${tagId}::uuid AND ${tags.ownerId} = ${bookmarks.ownerId})`;
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
    filter.folderId === undefined ? undefined : filedIn(filter.folderId),
    ...(filter.tagIds ?? []).map(tagged),
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

function recordOf(row: BookmarkRecordRow, filed: readonly BookmarkFolderRef[], carried: readonly BookmarkTagRef[]): BookmarkRecord {
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
    folders: filed,
    tags: carried,
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

/**
 * The tags of a selection as identifiers: the ones named by identifier, and the owner's tags of the names, created where there is none, without repeats.
 * The existing tags were locked by `lockTaggingTags` after the bookmark was, so none of them is gone by now; a name the owner has no tag of creates one here.
 */
async function tagIdsOf(tx: TenantTx, ownerId: string, tagging: BookmarkTagSelection): Promise<string[]> {
  const named = await resolveTagNames(tx, ownerId, tagging.names);
  return distinctIdentifiers([...tagging.ids, ...named]);
}

export function bookmarkRepository(tx: TenantTx): BookmarkRepository {
  const rows = scoped.bind(tx);
  return {
    async create({ bookmark, ceiling, jobs, folderIds = [], tags: tagging = { ids: [], names: [] } }) {
      if (tx.workspaceId === undefined) {
        throw new TenantContextError("workspace_required", "creating a bookmark needs a tenant transaction opened with a workspace");
      }
      // Before the first write: a folder that is not the owner's ends the call without taking a place under the ceiling. The folders are only read
      // here and locked after the workspace's row is (below), the order every other transaction takes the two in. The tags are only read here as
      // well and locked after the workspace's row and the new bookmark (below): src/repositories/tag-links.ts has the order of the locks.
      if (!(await lockOwnedFolders(tx, bookmark.ownerId, folderIds, false))) {
        return { kind: "folder_not_found" };
      }
      if (!(await ownedTagsExist(tx, bookmark.ownerId, tagging.ids))) {
        return { kind: "tag_not_found" };
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
      if (!(await lockOwnedFolders(tx, bookmark.ownerId, folderIds))) {
        // A folder that was there a moment ago is gone: the call ends with an error, which rolls the place and the bookmark back with it.
        throw new Error("a folder of the new bookmark was deleted while the bookmark was created");
      }
      await insertLinks(tx, folderIds, [stored.id]);
      if (!(await lockTaggingTags(tx, bookmark.ownerId, tagging))) {
        // A tag that was there a moment ago is gone: the call ends with an error, which rolls the place and the bookmark back with it.
        throw new Error("a tag of the new bookmark was deleted while the bookmark was created");
      }
      const tagIds = await tagIdsOf(tx, bookmark.ownerId, tagging);
      await insertTagLinks(tx, stored.id, tagIds);
      for (const job of jobs) {
        await enqueueInTenantTransaction(tx, job);
      }
      const filed = await foldersOfBookmarks(tx, bookmark.ownerId, [stored.id]);
      const carried = await tagsOfBookmarks(tx, bookmark.ownerId, [stored.id]);
      return { kind: "created", bookmark: recordOf(stored, filed.get(stored.id) ?? [], carried.get(stored.id) ?? []) };
    },

    async find(bookmarkId) {
      const [row] = await rows.select(and(eq(bookmarks.id, bookmarkId), isNull(bookmarks.planArchivedAt)));
      if (row === undefined) {
        return undefined;
      }
      const filed = await foldersOfBookmarks(tx, tx.accountId, [row.id]);
      const carried = await tagsOfBookmarks(tx, tx.accountId, [row.id]);
      return recordOf(row, filed.get(row.id) ?? [], carried.get(row.id) ?? []);
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
      // Before the first write: a folder that is not the owner's ends the call with the bookmark as it was.
      if (changes.folderIds !== undefined && !(await lockOwnedFolders(tx, ownerId, changes.folderIds))) {
        return { kind: "folder_not_found" };
      }
      // Locked, in the order of their identifiers, after the bookmark and before the first write (src/repositories/tag-links.ts has the order of the locks): a
      // tag that is not the owner's, or that a merge or a deletion has taken away, ends the call before a name of the change creates a tag.
      if (changes.tags !== undefined && !(await lockTaggingTags(tx, ownerId, changes.tags))) {
        return { kind: "tag_not_found" };
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
      const filedBefore = (await foldersOfBookmarks(tx, ownerId, [bookmarkId])).get(bookmarkId) ?? [];
      const carriedBefore = (await tagsOfBookmarks(tx, ownerId, [bookmarkId])).get(bookmarkId) ?? [];
      const wantedTags = changes.tags === undefined ? undefined : await tagIdsOf(tx, ownerId, changes.tags);
      const detaching = wantedTags === undefined ? [] : carriedBefore.filter((tag) => !wantedTags.includes(tag.id)).map((tag) => tag.id);
      const attaching = wantedTags === undefined ? [] : wantedTags.filter((id) => !carriedBefore.some((tag) => tag.id === id));
      const wantedFolders = changes.folderIds === undefined ? undefined : distinctIdentifiers(changes.folderIds);
      const leaving = wantedFolders === undefined ? [] : filedBefore.filter((folder) => !wantedFolders.includes(folder.id)).map((folder) => folder.id);
      const joining = wantedFolders === undefined ? [] : wantedFolders.filter((id) => !filedBefore.some((folder) => folder.id === id));
      if (Object.keys(set).length === 0 && leaving.length === 0 && joining.length === 0 && detaching.length === 0 && attaching.length === 0) {
        return { kind: "unchanged", bookmark: recordOf(current, filedBefore, carriedBefore) };
      }
      let row = current;
      if (Object.keys(set).length > 0) {
        const [updated] = await rows.update(set, eq(bookmarks.id, bookmarkId));
        if (updated === undefined) {
          throw new Error("changing a locked bookmark did not update exactly one row");
        }
        row = updated;
      }
      if (leaving.length > 0) {
        await deleteLinks(tx, leaving, [bookmarkId]);
      }
      if (joining.length > 0) {
        await insertLinks(tx, joining, [bookmarkId]);
      }
      if (detaching.length > 0) {
        await deleteTagLinks(tx, bookmarkId, detaching);
      }
      if (attaching.length > 0) {
        await insertTagLinks(tx, bookmarkId, attaching);
      }
      const filed = leaving.length === 0 && joining.length === 0 ? filedBefore : ((await foldersOfBookmarks(tx, ownerId, [bookmarkId])).get(bookmarkId) ?? []);
      const carried = detaching.length === 0 && attaching.length === 0 ? carriedBefore : ((await tagsOfBookmarks(tx, ownerId, [bookmarkId])).get(bookmarkId) ?? []);
      return { kind: "updated", bookmark: recordOf(row, filed, carried) };
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

    async removeMany({ bookmarkIds }) {
      if (tx.workspaceId === undefined) {
        throw new TenantContextError("workspace_required", "deleting bookmarks needs a tenant transaction opened with a workspace");
      }
      requireIdentifiers(bookmarkIds, "deleting bookmarks");
      const deleted = await tenantHandle(tx).execute<DeletedManyRow>(sql`
        SELECT public.sys_bookmark_delete_many(${tx.workspaceId}::uuid, ${uuidArray(bookmarkIds)}::uuid[]) AS deleted`);
      const row = deleted[0];
      if (deleted.length !== 1 || row === undefined) {
        throw new Error("sys_bookmark_delete_many did not return exactly one answer");
      }
      return row.deleted ?? undefined;
    },

    async setPinned({ bookmarkIds, ownerId, pinned }) {
      if (tx.workspaceId === undefined) {
        throw new TenantContextError("workspace_required", "pinning bookmarks needs a tenant transaction opened with a workspace");
      }
      if (ownerId.toLowerCase() !== tx.accountId.toLowerCase()) {
        throw new Error("only the account of the transaction pins its own bookmarks");
      }
      requireIdentifiers(bookmarkIds, "pinning bookmarks");
      const owned = await tenantHandle(tx)
        .select({ id: bookmarks.id, pinnedAt: bookmarks.pinnedAt })
        .from(bookmarks)
        .where(
          and(
            eq(bookmarks.workspaceId, tx.workspaceId),
            eq(bookmarks.ownerId, ownerId),
            isNull(bookmarks.planArchivedAt),
            sql`${bookmarks.id} = ANY (${uuidArray(bookmarkIds)}::uuid[])`,
          ),
        )
        .orderBy(bookmarks.id)
        .for("update");
      const toChange = owned.filter((row) => (row.pinnedAt !== null) !== pinned).map((row) => row.id);
      if (toChange.length > 0) {
        const changed = await rows.update({ pinnedAt: pinned ? new Date() : null }, sql`${bookmarks.id} = ANY (${uuidArray(toChange)}::uuid[])`);
        if (changed.length !== toChange.length) {
          throw new Error("pinning locked bookmarks did not update exactly the rows it locked");
        }
      }
      return owned.length;
    },

    async ids(filter, limit) {
      const workspaceId = requireListWorkspace(tx, "listing bookmark identifiers");
      const found = await tenantHandle(tx)
        .select({ id: bookmarks.id })
        .from(bookmarks)
        .where(listPredicate(workspaceId, filter))
        .orderBy(SORT_ORDERS.recent.order)
        .limit(limit);
      return found.map((row) => row.id);
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
      const filed = await foldersOfBookmarks(tx, request.filter.ownerId, found.map((row) => row.id));
      const carried = await tagsOfBookmarks(tx, request.filter.ownerId, found.map((row) => row.id));
      return found.map(({ sortKey, ...row }) => ({ bookmark: recordOf(row, filed.get(row.id) ?? [], carried.get(row.id) ?? []), key: sortKey }));
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
