import {
  createAuditWriter,
  type BookmarkArchiveTransaction,
  type BookmarkFilingMode,
  type BookmarkFolderRef,
  type BookmarkLinkingResult,
  type BookmarkPreviewTag,
  type BookmarkTagPreviewResult,
  type BookmarkTaggingMode,
  type BookmarkTagRef,
  type BookmarkTagSelection,
  type BookmarkListFilter,
  type BookmarkListPage,
  type BookmarkListRequest,
  type BookmarkListRow,
  type BookmarkOwner,
  type BookmarkRecord,
  type BookmarkSharedVia,
  type BookmarkSort,
  type BookmarkUpdateRequest,
  type BookmarkUpdateResult,
  type NewBookmark,
  type SlugUse,
} from "@slugbase/core";
import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { accounts } from "../schema/accounts.ts";
import { bookmarks } from "../schema/bookmarks.ts";
import { folderBookmarks, folders } from "../schema/folders.ts";
import { bookmarkTags, tags } from "../schema/tags.ts";
import { auditEventRepository } from "./audit-events.ts";
import { bookmarkReadableBy, bookmarkSharedByOwner, sharedBookmarks, sharedViaOf, type SharedVia } from "./bookmark-access.ts";
import { entitlementRepository } from "./entitlements.ts";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { deleteLinks, deleteLinksOutside, distinctIdentifiers, foldersOfBookmarks, insertLinks, lockOwnedFolders, requireIdentifiers, uuidArray } from "./folder-links.ts";
import { defineScopedRepository } from "./scoped.ts";
import { deleteTagLinks, deleteTagLinksMany, insertTagLinks, insertTagLinksMany, lockTaggingOwner, lockTaggingTags, ownedTags, ownedTagsExist, resolveTagNames, tagsOfBookmarks } from "./tag-links.ts";

// The bookmarks of the active workspace (doc 05 section 2.4, doc 02 section 5, doc 10 T1, T2 and T11). Reads, the insert and the
// update go through the scoped repository below, so every statement carries the workspace of the transaction and runs on the
// policies of `bookmarks` on top of that; `slugbase_app` may not delete a row, which is why the repository has no `delete`. A
// bookmark that is plan-archived is not one the product shows or edits, so a lookup and an update leave it out; its owner may still
// delete it. Changing and deleting a bookmark are its owner's: both name the owner in the statement, so another member's bookmark
// is a row the statement does not find. A delete is the system operation `sys_bookmark_delete`, which removes the row and gives
// its place under `bookmarks.max` back in the same statement of the transaction, so the counter and the rows cannot part; a bulk delete is `sys_bookmark_delete_many`, which lowers the counter once for all the rows it deletes. A bulk pin or unpin locks the caller's rows in identifier order and writes the pin of those not in the wanted state. A bulk filing or tagging locks the caller's rows (`FOR KEY SHARE`, in the order of their identifiers) and then the folder or the tags it acts with, the order of a change of one bookmark, and writes links only: no bookmark row changes, so no version moves. The place under
// `bookmarks.max` is taken by the system operation `sys_bookmark_count_take`, which locks the workspace's row, compares the
// workspace's `bookmark_count` with the ceiling and raises it, in the transaction that inserts the bookmark: a failed
// insert takes the place back with it, and two creations at the limit minus one make one. Archiving and restoring are the system
// operation `sys_bookmark_archive_set`, which sets or clears `plan_archived_at` for the given bookmarks, moves the counter by the rows
// that changed, in one call, because `slugbase_app` may write neither column; the `entitlement_version` is raised separately, through
// `sys_workspace_bump_entitlement_version` (`withEntitlementChange`, doc 01 section 7.5). A list is the bookmarks of the workspace that the scope of its filter
// covers (the caller's own, those shared with the caller, those the caller shares, or the first and the second together) in one of six orderings, resumed by a keyset:
// the sort key of the last row and its identifier, compared as a row, so the statement is a range scan of the index that serves the sort (doc 05 section 2.4) and the
// page costs the same at any depth. The caller's own bookmarks are read from that index; the ones shared with the caller are read from the set of the grants to the caller
// (src/repositories/bookmark-access.ts), each probed by primary key, so a list of them never scans the table, and the page of `all` is the better of the two sorted together.
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
// writes (src/sql/470-bookmarks.sql and 560-bookmark-slugs.sql): the slug and forwarding among them, but not the archive state, the usage, the
// owner or the version, so a row it writes is never archived and starts unused, and its version is moved by the trigger and by nothing it sends.
//
// The slug is unique per owner within the workspace (`bookmarks_owner_slug_key`), and the key is the judge of it. A creation and a change look for
// another bookmark of the owner with the slug first and answer `slug_taken` without writing; two statements that set one slug at once both pass
// that look, the second waits for the first's commit and then meets the key, and its statement fails, which ends the transaction it ran in with
// nothing written: `isBookmarkSlugTaken` tells that failure from any other so the caller answers it as a slug that is taken.
const scoped = defineScopedRepository("bookmarks", bookmarks, {
  methods: ["select", "insert", "update"],
  insertColumns: ["id", "ownerId", "url", "urlCanonical", "host", "title", "description", "slug", "forwarding", "pinnedAt"],
  updateColumns: ["url", "urlCanonical", "host", "title", "description", "slug", "forwarding", "pinnedAt"],
});

const UNIQUE_VIOLATION = "23505";
const SLUG_CONSTRAINT = "bookmarks_owner_slug_key";
const MAX_CAUSE_DEPTH = 4;

/** Whether the error is the database refusing a statement because the owner has a bookmark with that slug already, on the error itself or on one of its causes. */
export function isBookmarkSlugTaken(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    const { code, constraint_name: constraint, cause } = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (code === UNIQUE_VIOLATION && constraint === SLUG_CONSTRAINT) {
      return true;
    }
    current = cause;
  }
  return false;
}

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
  | { readonly kind: "tag_not_found" }
  /** The owner already has another bookmark with the slug in the workspace; nothing is written. */
  | { readonly kind: "slug_taken" };

/** Jobs an update queues in its own transaction. */
export interface BookmarkUpdateJobs {
  /** Queued only when the update changes the bookmark's address (`url`); nothing is queued for a change of any other column, for `unchanged` or for a refusal. */
  readonly jobsOnUrlChange?: readonly QueuedJob[];
}

export interface BookmarkRepository {
  /**
   * Takes one place under the ceiling, inserts the bookmark, files it in the folders and queues the jobs, in the open transaction. Nothing
   * is written for `limit_reached`, `unavailable`, `folder_not_found`, `tag_not_found` and `slug_taken`. The bookmark is tagged in the same transaction, and a name
   * of `tags` that the owner has no tag of creates one. Needs a transaction opened with a workspace.
   */
  create(creation: BookmarkCreation): Promise<BookmarkCreationResult>;
  /**
   * The bookmark of the workspace of the transaction with that identifier, when the account of the transaction can read it (it owns it, or it is shared with the account directly,
   * through a team or through a folder, doc 05 section 4); undefined when there is none, it is plan-archived or the account cannot read it. A bookmark shared with the account
   * comes with its owner and how it is shared, and with none of the owner's folders or tags and not the owner's pin. Needs a transaction opened with a workspace.
   */
  find(bookmarkId: string): Promise<BookmarkRecord | undefined>;
  /**
   * Whether the bookmark is shared with `accountId`: readable by it through a share, owned by someone else, not plan-archived. `accountId` is the account of the transaction.
   * Needs a transaction opened with a workspace.
   */
  sharedWith(request: { readonly bookmarkId: string; readonly accountId: string }): Promise<boolean>;
  /** Those of `bookmarkIds` that are shared with `accountId`, as `sharedWith` judges each. `accountId` is the account of the transaction. Needs a transaction opened with a workspace. */
  sharedAmong(request: { readonly bookmarkIds: readonly string[]; readonly accountId: string }): Promise<readonly string[]>;
  /**
   * Changes the bookmark that `ownerId` owns in the workspace of the transaction, unless it is plan-archived. The row is locked
   * first; when `expectedVersions` is given and the version under the lock is none of them the answer is `stale` and nothing is
   * written, and a patch that names the values the row has, in the folders it is in, is `unchanged`. `changes.folderIds` replaces the
   * owner's folders the bookmark is filed in, and `changes.tags` the owner's tags it carries; a folder or a tag that is not the owner's is
   * `folder_not_found` or `tag_not_found` with nothing written, and a name of `changes.tags` that the owner has no tag of creates one. A change
   * of the row's own columns moves the version by one (the trigger
   * `bookmarks_bump_version`). The jobs of `jobsOnUrlChange` are queued in the same transaction when the address changes. Needs a transaction
   * opened with a workspace.
   */
  update(request: BookmarkUpdateRequest & BookmarkUpdateJobs): Promise<BookmarkUpdateResult>;
  /**
   * Deletes the bookmark that `ownerId` owns in the workspace of the transaction, a plan-archived one included, and answers
   * whether there was one, through `sys_bookmark_delete`: the workspace's `bookmark_count` falls by one with the row unless the
   * bookmark was plan-archived. `ownerId` is the account of the transaction, which is the owner the function reads from the
   * session; another account is a programming error. Needs a transaction opened with a workspace.
   */
  remove(request: { readonly bookmarkId: string; readonly ownerId: string }): Promise<boolean>;
  /**
   * How `slug` is used in the workspace of the transaction: whether a bookmark of `ownerId` other than `exceptBookmarkId` has it, a plan-archived one included
   * since the key of the table counts it, and how many bookmarks of other owners (ownerless ones included) that are not plan-archived have it. A count and
   * a flag, never a row. `slug` is in its normal form and `ownerId` is the account of the transaction. Needs a transaction opened with a workspace.
   */
  slugUse(request: { readonly slug: string; readonly ownerId: string; readonly exceptBookmarkId: string | undefined }): Promise<SlugUse>;
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
   * Files the bookmarks of `bookmarkIds` that `ownerId` owns in the workspace of the transaction and that are not plan-archived in the folder `folderId` of the owner's
   * (`add`), in that folder alone (`move`: their links to every other folder are removed), or takes them out of it (`remove`), and answers how many such bookmarks there
   * are, whether or not they were filed so already. The bookmarks are locked first and then the folder, and a folder that is not the owner's is `target_not_found` with
   * nothing written, even when no bookmark is among the identifiers. `ownerId` is the account of the transaction. Needs a transaction opened with a workspace.
   */
  fileIn(request: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly folderId: string; readonly mode: BookmarkFilingMode }): Promise<BookmarkLinkingResult>;
  /**
   * Puts the tags `tagIds` on the bookmarks of `bookmarkIds` that `ownerId` owns and that are not plan-archived (`add`), or takes them off (`remove`), and answers how many
   * such bookmarks there are, whether or not they carried the tags already. The bookmarks are locked first and then the tags, and a tag that is not the owner's is
   * `target_not_found` with nothing written. `ownerId` is the account of the transaction. Needs a transaction opened with a workspace.
   */
  tag(request: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly tagIds: readonly string[]; readonly mode: BookmarkTaggingMode }): Promise<BookmarkLinkingResult>;
  /**
   * What `tag` with `add` would leave on the same bookmarks, read and not written, and not locked: how many bookmarks it reaches and the tags they would carry
   * afterwards, in the order of the tags' names, each with how many of them carry it afterwards and how many get it. A tag that is not the owner's is
   * `target_not_found`. Needs a transaction opened with a workspace.
   */
  previewTags(request: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly tagIds: readonly string[] }): Promise<BookmarkTagPreviewResult>;
  /**
   * The identifiers of the bookmarks of the scope of the filter (`filter.ownerId`'s own unless it says more) in the workspace of the transaction that match the filter, newest
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
   * The bookmarks of the scope of `request.filter` (`filter.ownerId`'s own unless it says more) in the workspace of the transaction that are not plan-archived, in the order
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
  /**
   * What `list(request)` answers together with what `count(request.filter, limit)` answers. A filter that is a text query and nothing else
   * takes both from one call of `sys_bookmark_match`, whose matches are exactly what the filter matches; every other filter is read by
   * `list` and `count` as they are. Needs a transaction opened with a workspace.
   */
  listWithCount(request: BookmarkListRequest, limit: number): Promise<BookmarkListPage>;
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

/** The part of a scope a statement reads: the caller's own bookmarks, those shared with the caller, or the caller's own that are shared with anyone. */
type Branch = "own" | "shared" | "sharedByMe";

/**
 * The parts of the scope of `filter`. A filter that names the caller's folder or tags, or the URL of the duplicate warning, reaches the caller's own bookmarks alone: a bookmark shared
 * with the caller is filed in none of their folders and carries none of their tags (Q22), and the warning is about what they saved themselves (doc 04 section 10.6).
 */
function branchesOf(filter: BookmarkListFilter): readonly Branch[] {
  const own = filter.folderId !== undefined || (filter.tagIds ?? []).length > 0 || filter.urlCanonical !== undefined;
  switch (filter.scope ?? "mine") {
    case "mine":
      return ["own"];
    case "all":
      return own ? ["own"] : ["own", "shared"];
    case "shared_with_me":
      return own ? [] : ["shared"];
    case "shared_by_me":
      return ["sharedByMe"];
  }
}

/** Whether the filter reads only the caller's own bookmarks without any share: the list of the index of the sort. */
function isOwnScope(filter: BookmarkListFilter): boolean {
  return (filter.scope ?? "mine") === "mine";
}

/** The pin condition: a pin is the owner's (Q22), so a bookmark shared with the caller is never pinned for them. */
function pinnedCondition(pinned: boolean | undefined, shared: boolean): SQL | undefined {
  if (pinned === undefined) {
    return undefined;
  }
  if (shared) {
    return pinned ? sql`false` : undefined;
  }
  return pinned ? isNotNull(bookmarks.pinnedAt) : isNull(bookmarks.pinnedAt);
}

/**
 * The predicate of one part of a list and of its count without the text query: the workspace, whose bookmark it is, never a plan-archived bookmark, and the filters given. The
 * part of the bookmarks shared with the caller is read as the access predicate says (`bookmarkReadableBy`), unless the statement drives from the set of the grants and so
 * probes only bookmarks that are in it (`driven`).
 */
function branchPredicate(workspaceId: string, filter: BookmarkListFilter, branch: Branch, driven = false): SQL {
  const shared = branch === "shared";
  const predicate = and(
    eq(bookmarks.workspaceId, workspaceId),
    shared ? sql`${bookmarks.ownerId} IS DISTINCT FROM ${filter.ownerId}::uuid` : eq(bookmarks.ownerId, filter.ownerId),
    shared && !driven ? bookmarkReadableBy(filter.ownerId) : undefined,
    branch === "sharedByMe" ? bookmarkSharedByOwner() : undefined,
    isNull(bookmarks.planArchivedAt),
    pinnedCondition(filter.pinned, shared),
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

/** The predicate of a list and of its count without the text query, over all the parts of its scope: nothing matches when the scope reads none. */
function filterPredicate(workspaceId: string, filter: BookmarkListFilter): SQL {
  const branches = branchesOf(filter).map((branch) => branchPredicate(workspaceId, filter, branch));
  return branches.length === 1 ? (branches[0] ?? sql`false`) : (or(...branches) ?? sql`false`);
}

/** The predicate of a list of the caller's own bookmarks that has no text query. A filter with one is read by the statements of `matchedPage` and `matchedCount`, which this one never serves. */
function listPredicate(workspaceId: string, filter: BookmarkListFilter): SQL {
  if (filter.q !== undefined) {
    throw new Error("a list with a text query is read through the matches of sys_bookmark_match");
  }
  if (!isOwnScope(filter)) {
    throw new Error("a list of a scope that holds bookmarks shared with the caller is read through the statements of pageStatement and countStatement");
  }
  return filterPredicate(workspaceId, filter);
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
  /** The direction of the sort, with the placement of NULL, which the identifier tiebreak follows. */
  readonly dir: SQL;
  readonly order: SQL;
  readonly direction: "<" | ">";
}

function sortOrder(column: SQL, key: SQL, cast: SortOrder["cast"], dir: string, direction: SortOrder["direction"]): SortOrder {
  const placed = sql.raw(dir);
  return { column, key, cast, dir: placed, order: sql`${column} ${placed}, ${bookmarks.id} ${placed}`, direction };
}

const SORT_ORDERS: Readonly<Record<BookmarkSort, SortOrder>> = {
  recent: sortOrder(sql`${bookmarks.createdAt}`, sql`${bookmarks.createdAt}::text`, "timestamptz", "DESC NULLS LAST", "<"),
  oldest: sortOrder(sql`${bookmarks.createdAt}`, sql`${bookmarks.createdAt}::text`, "timestamptz", "ASC NULLS FIRST", ">"),
  title_asc: sortOrder(sql`lower(${bookmarks.title})`, sql`lower(${bookmarks.title})`, "text", "ASC NULLS LAST", ">"),
  title_desc: sortOrder(sql`lower(${bookmarks.title})`, sql`lower(${bookmarks.title})`, "text", "DESC NULLS FIRST", "<"),
  most_used: sortOrder(sql`${bookmarks.openCount}`, sql`${bookmarks.openCount}::text`, "bigint", "DESC NULLS LAST", "<"),
  recently_opened: sortOrder(sql`${bookmarks.lastOpenedAt}`, sql`${bookmarks.lastOpenedAt}::text`, "timestamptz", "DESC NULLS LAST", "<"),
};

/** How a bookmark of another member is shared with the reader, and who owns it: what a record of such a bookmark carries besides the fields of the row. */
interface Sharing {
  readonly owner: BookmarkOwner | null;
  readonly via: BookmarkSharedVia;
}

function recordOf(row: BookmarkRecordRow, filed: readonly BookmarkFolderRef[], carried: readonly BookmarkTagRef[], sharing?: Sharing): BookmarkRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    url: row.url,
    host: row.host,
    title: row.title,
    description: row.description,
    slug: row.slug,
    forwarding: row.forwarding,
    pinned: sharing === undefined && row.pinnedAt !== null,
    openCount: row.openCount,
    lastOpenedAt: row.lastOpenedAt,
    owner: sharing?.owner ?? null,
    sharedVia: sharing?.via ?? null,
    folders: filed,
    tags: carried,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Who owns the bookmarks of `rows`, which belong to other members than `viewerId` or to none, and how each is shared with `viewerId`: by identifier. A bookmark that is no longer
 * shared with the viewer by the time its route is read (a share revoked since the row was) is not in the answer.
 */
async function sharingOf(tx: TenantTx, viewerId: string, rows: readonly BookmarkRecordRow[]): Promise<Map<string, Sharing>> {
  const workspaceId = requireListWorkspace(tx, "reading how bookmarks are shared");
  const handle = tenantHandle(tx);
  const routes = await handle.execute<{ bookmark_id: string; via: SharedVia }>(sharedViaOf(viewerId, workspaceId, rows.map((row) => row.id)));
  const ownerIds = [...new Set(rows.flatMap((row) => (row.ownerId === null ? [] : [row.ownerId])))];
  const names =
    ownerIds.length === 0
      ? []
      : await handle
          .select({ id: accounts.id, displayName: accounts.displayName })
          .from(accounts)
          .where(sql`${accounts.id} = ANY (${uuidArray(ownerIds)}::uuid[])`);
  const nameOf = new Map(names.map((account) => [account.id, account.displayName]));
  const found = new Map<string, Sharing>();
  for (const { bookmark_id: bookmarkId, via } of routes) {
    const ownerId = rows.find((row) => row.id === bookmarkId)?.ownerId ?? null;
    const displayName = ownerId === null ? undefined : nameOf.get(ownerId);
    found.set(bookmarkId, { owner: ownerId === null || displayName === undefined ? null : { accountId: ownerId, displayName }, via });
  }
  return found;
}

/**
 * The records of `rows`, which `viewerId` can read, in their order. The folders and the tags are the viewer's own, and the viewer files and tags only what is theirs, so a bookmark
 * shared with them carries none of the owner's; such a bookmark carries its owner and how it is shared instead, and is left out when that share has ended meanwhile.
 */
async function recordsOf(tx: TenantTx, viewerId: string, rows: readonly BookmarkRecordRow[]): Promise<BookmarkRecord[]> {
  if (rows.length === 0) {
    return [];
  }
  const ids = rows.map((row) => row.id);
  const filed = await foldersOfBookmarks(tx, viewerId, ids);
  const carried = await tagsOfBookmarks(tx, viewerId, ids);
  const viewer = viewerId.toLowerCase();
  const foreign = rows.filter((row) => row.ownerId?.toLowerCase() !== viewer);
  const sharing = foreign.length === 0 ? new Map<string, Sharing>() : await sharingOf(tx, viewerId, foreign);
  return rows.flatMap((row) => {
    if (row.ownerId?.toLowerCase() === viewer) {
      return [recordOf(row, filed.get(row.id) ?? [], carried.get(row.id) ?? [])];
    }
    const route = sharing.get(row.id);
    return route === undefined ? [] : [recordOf(row, filed.get(row.id) ?? [], carried.get(row.id) ?? [], route)];
  });
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

// A list with a text query (`filter.q`) reads the bookmarks that match through the system operation `sys_bookmark_match` (src/sql/610-bookmark-match.sql): the policy of `bookmarks` is
// FORCEd and the operators of the search are not leakproof, so as slugbase_app they would never be index conditions. The operation answers the identifiers of the matches that the caller can read (their own and those shared with them), not
// plan-archived, and nothing else, as one materialised set that the statement below reads once; every other predicate of the list (the scope, the filters, the keyset, the owner, the
// workspace and the archive state) is still the statement's own, and the policy applies to every row it reads.
//
// The cost of the page depends on how many bookmarks match, and the statement does not know that before it runs, so it holds both plans and runs the one that is cheap for the
// count it finds: up to `FEW_MATCHES` (the total a list counts exactly, Q42) the page probes each match by the primary key of `bookmarks` and sorts what survives the other predicates, which reads as many
// rows as there are matches; above it the page walks the index of its sort in order, as a list without a text does, and tests each row against the set, which reads about as many rows as the page
// holds divided by the share of the workspace that matches, and at most the workspace. The branch that is not chosen is not run (its one-time filter reads the count). The probe is a lateral subquery
// that the planner cannot flatten (`OFFSET 0`), so it is always a nested loop over the matches and never a scan of the table; the set is tested in the walk behind a term that the planner cannot fold
// (`random() < 0`), so that it stays a filter of the walk and does not become a join that drives it. The page is read as identifiers and sort keys, and the rows are read in a second statement by
// identifier, so the records are made by the code that makes them for a list without a text.
const FEW_MATCHES = 10_000;

interface MatchedPageRow extends Record<string, unknown> {
  /** Null in the one row of a page that holds no bookmark, which still carries `matched`. */
  id: string | null;
  sort_key: string | null;
  /** How many bookmarks `sys_bookmark_match` answered, not cut: the same number in every row of a page. */
  matched: number;
}

/**
 * The statement of the page of a list with a text query, exported for the test that plans it: identifiers and sort keys in the order of the sort, each with how many matches the function answered.
 * A page with no bookmark is one row with a null identifier, so the count comes from the same call of the function. Needs a transaction opened with a workspace.
 */
export function matchedPageStatement(tx: TenantTx, { filter, sort, after, limit }: BookmarkListRequest): SQL {
  const workspaceId = requireListWorkspace(tx, "listing bookmarks");
  if (filter.q === undefined) {
    throw new Error("a page of matches needs a text query");
  }
  if (!isOwnScope(filter)) {
    requireViewer(tx, filter);
  }
  const { column, key, order, dir } = SORT_ORDERS[sort];
  const predicate = after === undefined ? filterPredicate(workspaceId, filter) : and(filterPredicate(workspaceId, filter), afterPosition(sort, after));
  const few = sql.raw(String(FEW_MATCHES));
  return sql`
    WITH m AS MATERIALIZED (SELECT id FROM sys_bookmark_match(${filter.q}::text)),
         c AS MATERIALIZED (SELECT count(*) AS n FROM m)
    SELECT page.id, page.sort_key, c.n::int AS matched FROM c LEFT JOIN (
      (SELECT probed.id, probed.ord, probed.sort_key FROM m
       CROSS JOIN LATERAL (SELECT ${bookmarks.id} AS id, ${column} AS ord, ${key} AS sort_key FROM ${bookmarks} WHERE ${bookmarks.id} = m.id AND ${predicate} OFFSET 0) probed
       WHERE (SELECT n FROM c) <= ${few}
       ORDER BY probed.ord ${dir}, probed.id ${dir} LIMIT ${limit}::integer)
      UNION ALL
      (SELECT ${bookmarks.id} AS id, ${column} AS ord, ${key} AS sort_key FROM ${bookmarks}
       WHERE ${predicate} AND (${bookmarks.id} IN (SELECT id FROM m) OR random() < 0) AND (SELECT n FROM c) > ${few}
       ORDER BY ${order} LIMIT ${limit}::integer)
    ) page ON true
    ORDER BY page.ord ${dir}, page.id ${dir} LIMIT ${limit}::integer`;
}

/**
 * The filter is a text query and nothing else, the owner is the account of the transaction and the scope is the account's own with the shared ones (`all`): the bookmarks it matches
 * are exactly the answer of `sys_bookmark_match`, which applies the workspace, the account, the access rule and the plan-archive rule itself, so the answer can be counted without reading the
 * bookmarks. Any other filter narrows the answer by a predicate of the statement (the scope `mine` leaves out the shared matches), and an owner other than the account matches nothing, so those
 * are counted by probing.
 */
function matchesAreTheAnswer(tx: TenantTx, filter: BookmarkListFilter): boolean {
  return (
    filter.q !== undefined &&
    filter.ownerId.toLowerCase() === tx.accountId.toLowerCase() &&
    filter.scope === "all" &&
    filter.pinned === undefined &&
    filter.hasSlug === undefined &&
    filter.forwarding === undefined &&
    filter.urlCanonical === undefined &&
    filter.folderId === undefined &&
    (filter.tagIds ?? []).length === 0
  );
}

/**
 * The statement of the count of a filter with a text query, exported for the test that plans it. Needs a transaction opened with a workspace. A filter that `matchesAreTheAnswer`
 * counts the answer of the function; any other counts the matches that survive the filter, probing each by the primary key, up to the limit.
 */
export function matchedCountStatement(tx: TenantTx, filter: BookmarkListFilter, limit: number): SQL {
  const workspaceId = requireListWorkspace(tx, "counting bookmarks");
  if (filter.q === undefined) {
    throw new Error("a count of matches needs a text query");
  }
  if (!isOwnScope(filter)) {
    requireViewer(tx, filter);
  }
  if (matchesAreTheAnswer(tx, filter)) {
    return sql`SELECT least(count(*), ${limit}::integer)::int AS total FROM sys_bookmark_match(${filter.q}::text)`;
  }
  return sql`
    WITH m AS MATERIALIZED (SELECT id FROM sys_bookmark_match(${filter.q}::text))
    SELECT count(*)::int AS total FROM (
      SELECT 1 FROM m
      CROSS JOIN LATERAL (SELECT 1 FROM ${bookmarks} WHERE ${bookmarks.id} = m.id AND ${filterPredicate(workspaceId, filter)} OFFSET 0) probed
      LIMIT ${limit}::integer) capped`;
}

/** The page of a list with a text query: the bookmarks of the page, and how many matches the function answered, which an empty page carries too. */
async function matchedPage(tx: TenantTx, request: BookmarkListRequest): Promise<{ readonly page: readonly { readonly id: string; readonly sort_key: string | null }[]; readonly matched: number }> {
  const found = await tenantHandle(tx).execute<MatchedPageRow>(matchedPageStatement(tx, request));
  const matched = found[0]?.matched;
  if (matched === undefined) {
    throw new Error("listing bookmarks returned no row");
  }
  return { page: found.flatMap(({ id, sort_key }) => (id === null ? [] : [{ id, sort_key }])), matched };
}

async function matchedCount(tx: TenantTx, filter: BookmarkListFilter, limit: number): Promise<number> {
  const [row] = await tenantHandle(tx).execute<{ total: number }>(matchedCountStatement(tx, filter, limit));
  if (row === undefined) {
    throw new Error("counting bookmarks returned no row");
  }
  return row.total;
}

/** A page of a list with a text query as bookmark records, in the order of its sort, with how many matches the function answered. */
async function matchedList(tx: TenantTx, request: BookmarkListRequest): Promise<{ readonly rows: readonly BookmarkListRow[]; readonly matched: number }> {
  const { page, matched } = await matchedPage(tx, request);
  return { rows: await rowsOfPage(tx, request.filter, page), matched };
}

/**
 * The rows of a page given as identifiers and sort keys, read by identifier in the order of the page: the bookmarks the filter's account can read, so a row whose route has ended
 * since the page was read is left out. The account's own scope reads by owner, which is what that scope's page was read by.
 */
async function rowsOfPage(tx: TenantTx, filter: BookmarkListFilter, page: readonly { readonly id: string; readonly sort_key: string | null }[]): Promise<BookmarkListRow[]> {
  const workspaceId = requireListWorkspace(tx, "listing bookmarks");
  const ids = page.map((row) => row.id);
  if (ids.length === 0) {
    return [];
  }
  const found = await tenantHandle(tx)
    .select(RECORD_COLUMNS)
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.workspaceId, workspaceId),
        isOwnScope(filter) ? eq(bookmarks.ownerId, filter.ownerId) : bookmarkReadableBy(filter.ownerId),
        isNull(bookmarks.planArchivedAt),
        sql`${bookmarks.id} = ANY (${uuidArray(ids)}::uuid[])`,
      ),
    );
  const byId = new Map(found.map((row) => [row.id, row]));
  const ordered = page.flatMap(({ id }) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
  const records = new Map((await recordsOf(tx, filter.ownerId, ordered)).map((record) => [record.id, record]));
  return page.flatMap(({ id, sort_key: key }) => {
    const bookmark = records.get(id);
    return bookmark === undefined ? [] : [{ bookmark, key }];
  });
}

function requireViewer(tx: TenantTx, filter: BookmarkListFilter): void {
  if (filter.ownerId.toLowerCase() !== tx.accountId.toLowerCase()) {
    throw new Error("only the account of the transaction lists the bookmarks that are shared with it or that it shares");
  }
}

/** The grants to the account, read once as the set a list of the shared bookmarks is driven from. */
function grantsCte(tx: TenantTx, workspaceId: string, branches: readonly Branch[]): SQL {
  return branches.includes("shared") ? sql`WITH shared AS MATERIALIZED (${sharedBookmarks(tx.accountId, workspaceId)})` : sql``;
}

/**
 * The statement of a page of a list of a scope that holds bookmarks shared with the caller (or that the caller shares), exported for the test that plans it: identifiers and sort keys in
 * the order of the sort, without a text query. Each part of the scope is one leg of a union: the caller's own bookmarks are read from the index of the sort, as a list of them is, and
 * the shared ones are driven from the set of the grants to the caller and probed by primary key, a lateral subquery the planner cannot flatten (`OFFSET 0`), so the table is never scanned for
 * them. Each leg is cut at the page and the union is sorted again, so the page is the first of the legs together. A bookmark readable through two routes is in the set once, and an own
 * bookmark is never in the shared leg, so no bookmark is in the page twice. Undefined when the scope and the filter read no part. Needs a transaction opened with a workspace.
 */
export function pageStatement(tx: TenantTx, { filter, sort, after, limit }: BookmarkListRequest): SQL | undefined {
  const workspaceId = requireListWorkspace(tx, "listing bookmarks");
  requireViewer(tx, filter);
  if (filter.q !== undefined) {
    throw new Error("a page of matches is read through the matches of sys_bookmark_match");
  }
  const branches = branchesOf(filter);
  if (branches.length === 0) {
    return undefined;
  }
  const { column, key, order, dir } = SORT_ORDERS[sort];
  const legs = branches.map((branch) => {
    const base = branchPredicate(workspaceId, filter, branch, branch === "shared");
    const predicate = after === undefined ? base : and(base, afterPosition(sort, after));
    if (branch !== "shared") {
      return sql`(SELECT ${bookmarks.id} AS id, ${column} AS ord, ${key} AS sort_key FROM ${bookmarks} WHERE ${predicate} ORDER BY ${order} LIMIT ${limit}::integer)`;
    }
    return sql`(SELECT probed.id, probed.ord, probed.sort_key FROM shared
      CROSS JOIN LATERAL (SELECT ${bookmarks.id} AS id, ${column} AS ord, ${key} AS sort_key FROM ${bookmarks} WHERE ${bookmarks.id} = shared.bookmark_id AND ${predicate} OFFSET 0) probed
      ORDER BY probed.ord ${dir}, probed.id ${dir} LIMIT ${limit}::integer)`;
  });
  return sql`${grantsCte(tx, workspaceId, branches)}
    SELECT page.id, page.sort_key FROM (${sql.join(legs, sql` UNION ALL `)}) page ORDER BY page.ord ${dir}, page.id ${dir} LIMIT ${limit}::integer`;
}

/** The statement of the count of a list of a scope that holds bookmarks shared with the caller, exported for the test that plans it: the legs of `pageStatement`, each cut at `limit`. Undefined when the scope and the filter read no part. */
export function countStatement(tx: TenantTx, filter: BookmarkListFilter, limit: number): SQL | undefined {
  const workspaceId = requireListWorkspace(tx, "counting bookmarks");
  requireViewer(tx, filter);
  if (filter.q !== undefined) {
    throw new Error("a count of matches is read through the matches of sys_bookmark_match");
  }
  const branches = branchesOf(filter);
  if (branches.length === 0) {
    return undefined;
  }
  const legs = branches.map((branch) => {
    const predicate = branchPredicate(workspaceId, filter, branch, branch === "shared");
    if (branch !== "shared") {
      return sql`(SELECT 1 FROM ${bookmarks} WHERE ${predicate} LIMIT ${limit}::integer)`;
    }
    return sql`(SELECT 1 FROM shared CROSS JOIN LATERAL (SELECT 1 FROM ${bookmarks} WHERE ${bookmarks.id} = shared.bookmark_id AND ${predicate} OFFSET 0) probed LIMIT ${limit}::integer)`;
  });
  return sql`${grantsCte(tx, workspaceId, branches)}
    SELECT least(count(*), ${limit}::integer)::int AS total FROM (${sql.join(legs, sql` UNION ALL `)}) capped`;
}

/** A page of a list that holds bookmarks shared with the caller, or that the caller shares, as records in the order of its sort. */
async function scopedList(tx: TenantTx, request: BookmarkListRequest): Promise<BookmarkListRow[]> {
  const statement = pageStatement(tx, request);
  if (statement === undefined) {
    return [];
  }
  return rowsOfPage(tx, request.filter, await tenantHandle(tx).execute<{ id: string; sort_key: string | null }>(statement));
}

async function listOf(tx: TenantTx, request: BookmarkListRequest): Promise<readonly BookmarkListRow[]> {
  if (request.filter.q !== undefined) {
    return (await matchedList(tx, request)).rows;
  }
  if (!isOwnScope(request.filter)) {
    return scopedList(tx, request);
  }
  const found = await listQuery(tx, request);
  const filed = await foldersOfBookmarks(tx, request.filter.ownerId, found.map((row) => row.id));
  const carried = await tagsOfBookmarks(tx, request.filter.ownerId, found.map((row) => row.id));
  return found.map(({ sortKey, ...row }) => ({ bookmark: recordOf(row, filed.get(row.id) ?? [], carried.get(row.id) ?? []), key: sortKey }));
}

async function countOf(tx: TenantTx, filter: BookmarkListFilter, limit: number): Promise<number> {
  if (filter.q !== undefined) {
    return matchedCount(tx, filter, limit);
  }
  if (!isOwnScope(filter)) {
    const statement = countStatement(tx, filter, limit);
    if (statement === undefined) {
      return 0;
    }
    const [shared] = await tenantHandle(tx).execute<{ total: number }>(statement);
    if (shared === undefined) {
      throw new Error("counting bookmarks returned no row");
    }
    return shared.total;
  }
  const [row] = await countQuery(tx, filter, limit);
  if (row === undefined) {
    throw new Error("counting bookmarks returned no row");
  }
  return row.total;
}

async function listWithCountOf(tx: TenantTx, request: BookmarkListRequest, limit: number): Promise<BookmarkListPage> {
  if (!matchesAreTheAnswer(tx, request.filter)) {
    const rows = await listOf(tx, request);
    return { rows, count: await countOf(tx, request.filter, limit) };
  }
  const { rows, matched } = await matchedList(tx, request);
  return { rows, count: Math.min(matched, limit) };
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
 * Answers `undefined`, with the tags it created undone, when a tag that the insert of a name left (made by another transaction that committed) is deleted by a different transaction before it is read back (`resolveTagNames`).
 */
async function tagIdsOf(tx: TenantTx, ownerId: string, tagging: BookmarkTagSelection): Promise<string[] | undefined> {
  const named = await resolveTagNames(tx, ownerId, tagging.names);
  return named === undefined ? undefined : distinctIdentifiers([...tagging.ids, ...named]);
}

/**
 * The identifiers of the bookmarks of `bookmarkIds` that `ownerId` owns in the workspace of the transaction and that are not plan-archived, in the order of their
 * identifiers; locked `FOR KEY SHARE` unless `lock` is false, so a bookmark that a concurrent transaction deletes is waited for and left out, and none is gone under the links written next.
 */
async function ownedLiveBookmarks(tx: TenantTx, workspaceId: string, ownerId: string, bookmarkIds: readonly string[], lock: boolean): Promise<string[]> {
  const wanted = distinctIdentifiers(bookmarkIds);
  requireIdentifiers(wanted, "acting on bookmarks");
  if (wanted.length === 0) {
    return [];
  }
  const query = tenantHandle(tx)
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.workspaceId, workspaceId), eq(bookmarks.ownerId, ownerId), isNull(bookmarks.planArchivedAt), sql`${bookmarks.id} = ANY (${uuidArray(wanted)}::uuid[])`))
    .orderBy(bookmarks.id);
  return (lock ? await query.for("key share") : await query).map((row) => row.id);
}

function requireAccountOwner(tx: TenantTx, ownerId: string, action: string): void {
  if (ownerId.toLowerCase() !== tx.accountId.toLowerCase()) {
    throw new Error(`only the account of the transaction ${action} its own bookmarks`);
  }
}

/** Whether a bookmark of `ownerId` other than `exceptBookmarkId` has `slug` in the workspace of the transaction, whatever its archive state: the key of the table counts them all. */
async function ownerHasSlug(tx: TenantTx, workspaceId: string, ownerId: string, slug: string, exceptBookmarkId: string | undefined): Promise<boolean> {
  const [found] = await tenantHandle(tx)
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.workspaceId, workspaceId), eq(bookmarks.ownerId, ownerId), eq(bookmarks.slug, slug), exceptBookmarkId === undefined ? undefined : sql`${bookmarks.id} <> ${exceptBookmarkId}::uuid`))
    .limit(1);
  return found !== undefined;
}

const CREATION_SAVEPOINT = sql.raw("bookmark_creation");

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
      if (bookmark.slug !== undefined && (await ownerHasSlug(tx, tx.workspaceId, bookmark.ownerId, bookmark.slug, undefined))) {
        return { kind: "slug_taken" };
      }
      // A folder or a tag that the pre-checks above found can still be deleted by the time it is locked below, after the place was taken and the bookmark inserted:
      // the call then undoes everything from here (`ROLLBACK TO SAVEPOINT`, which also releases the locks taken since) and answers `folder_not_found` or `tag_not_found`.
      await tenantHandle(tx).execute(sql`SAVEPOINT ${CREATION_SAVEPOINT}`);
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
        slug: bookmark.slug ?? null,
        forwarding: bookmark.forwarding ?? false,
        pinnedAt: bookmark.pinned ? new Date() : null,
      });
      if (!(await lockOwnedFolders(tx, bookmark.ownerId, folderIds))) {
        // A folder that was there a moment ago is gone: the place and the bookmark are undone, and the answer is the one a folder that was never there gets.
        await tenantHandle(tx).execute(sql`ROLLBACK TO SAVEPOINT ${CREATION_SAVEPOINT}`);
        await tenantHandle(tx).execute(sql`RELEASE SAVEPOINT ${CREATION_SAVEPOINT}`);
        return { kind: "folder_not_found" };
      }
      await insertLinks(tx, folderIds, [stored.id]);
      // A tag that was there a moment ago is gone: the place, the bookmark and whatever the call wrote since the savepoint are undone, and the answer is the one
      // a tag that was never there gets.
      const tagIds = (await lockTaggingTags(tx, bookmark.ownerId, tagging)) ? await tagIdsOf(tx, bookmark.ownerId, tagging) : undefined;
      if (tagIds === undefined) {
        await tenantHandle(tx).execute(sql`ROLLBACK TO SAVEPOINT ${CREATION_SAVEPOINT}`);
        await tenantHandle(tx).execute(sql`RELEASE SAVEPOINT ${CREATION_SAVEPOINT}`);
        return { kind: "tag_not_found" };
      }
      await insertTagLinks(tx, stored.id, tagIds);
      await tenantHandle(tx).execute(sql`RELEASE SAVEPOINT ${CREATION_SAVEPOINT}`);
      for (const job of jobs) {
        await enqueueInTenantTransaction(tx, job);
      }
      const filed = await foldersOfBookmarks(tx, bookmark.ownerId, [stored.id]);
      const carried = await tagsOfBookmarks(tx, bookmark.ownerId, [stored.id]);
      return { kind: "created", bookmark: recordOf(stored, filed.get(stored.id) ?? [], carried.get(stored.id) ?? []) };
    },

    async find(bookmarkId) {
      const [row] = await rows.select(and(eq(bookmarks.id, bookmarkId), isNull(bookmarks.planArchivedAt), bookmarkReadableBy(tx.accountId)));
      if (row === undefined) {
        return undefined;
      }
      const [record] = await recordsOf(tx, tx.accountId, [row]);
      return record;
    },

    async sharedWith({ bookmarkId, accountId }) {
      requireAccountOwner(tx, accountId, "asks whether it is shared with it");
      const [row] = await rows.select(
        and(eq(bookmarks.id, bookmarkId), isNull(bookmarks.planArchivedAt), sql`${bookmarks.ownerId} IS DISTINCT FROM ${accountId}::uuid`, bookmarkReadableBy(accountId)),
      );
      return row !== undefined;
    },

    async sharedAmong({ bookmarkIds, accountId }) {
      const workspaceId = requireListWorkspace(tx, "asking which bookmarks are shared");
      requireAccountOwner(tx, accountId, "asks which bookmarks are shared with it");
      requireIdentifiers(bookmarkIds, "asking which bookmarks are shared");
      if (bookmarkIds.length === 0) {
        return [];
      }
      const found = await tenantHandle(tx)
        .select({ id: bookmarks.id })
        .from(bookmarks)
        .where(
          and(
            eq(bookmarks.workspaceId, workspaceId),
            sql`${bookmarks.id} = ANY (${uuidArray(distinctIdentifiers(bookmarkIds))}::uuid[])`,
            isNull(bookmarks.planArchivedAt),
            sql`${bookmarks.ownerId} IS DISTINCT FROM ${accountId}::uuid`,
            bookmarkReadableBy(accountId),
          ),
        );
      return found.map((row) => row.id);
    },

    async update({ bookmarkId, ownerId, changes, expectedVersions, jobsOnUrlChange = [] }) {
      if (tx.workspaceId === undefined) {
        throw new TenantContextError("workspace_required", "changing a bookmark needs a tenant transaction opened with a workspace");
      }
      // A change that names a tag by name may create one, and the insert takes the workspace row and the owner's membership row (`FOR KEY SHARE`) through its
      // foreign keys. Every departure takes those two before the member's bookmarks, so they are taken here before the bookmark (src/repositories/tag-links.ts has the
      // order of the locks). An owner who has left, or been removed, finds no membership row and is answered as for a bookmark that is not theirs.
      if (changes.tags !== undefined && changes.tags.names.length > 0 && !(await lockTaggingOwner(tx, ownerId))) {
        return { kind: "not_found" };
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
      // Before the first write: a bookmark never forwards without a slug, whichever of the two the patch changes, and a slug the owner has on another bookmark ends the call.
      const wantedSlug = changes.slug === undefined ? current.slug : changes.slug;
      if ((changes.forwarding ?? current.forwarding) && wantedSlug === null) {
        return { kind: "forwarding_requires_slug" };
      }
      if (changes.slug !== undefined && changes.slug !== null && changes.slug !== current.slug && (await ownerHasSlug(tx, tx.workspaceId, ownerId, changes.slug, bookmarkId))) {
        return { kind: "slug_taken" };
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
      if (changes.slug !== undefined && changes.slug !== current.slug) {
        set.slug = changes.slug;
      }
      if (changes.forwarding !== undefined && changes.forwarding !== current.forwarding) {
        set.forwarding = changes.forwarding;
      }
      if (changes.pinned !== undefined && changes.pinned !== (current.pinnedAt !== null)) {
        set.pinnedAt = changes.pinned ? new Date() : null;
      }
      const filedBefore = (await foldersOfBookmarks(tx, ownerId, [bookmarkId])).get(bookmarkId) ?? [];
      const carriedBefore = (await tagsOfBookmarks(tx, ownerId, [bookmarkId])).get(bookmarkId) ?? [];
      let wantedTags: string[] | undefined;
      if (changes.tags !== undefined) {
        wantedTags = await tagIdsOf(tx, ownerId, changes.tags);
        if (wantedTags === undefined) {
          // A tag of a name was deleted before it was read back; the tags this call created for the names are undone, and nothing else is written yet.
          return { kind: "tag_not_found" };
        }
      }
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
      if (set.url !== undefined) {
        for (const job of jobsOnUrlChange) {
          await enqueueInTenantTransaction(tx, job);
        }
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

    async slugUse({ slug, ownerId, exceptBookmarkId }) {
      const workspaceId = requireListWorkspace(tx, "reading the use of a slug");
      requireAccountOwner(tx, ownerId, "reads the use of a slug for");
      const [row] = await tenantHandle(tx)
        .select({
          mine: sql<number>`(count(*) FILTER (WHERE ${bookmarks.ownerId} = ${ownerId}::uuid AND ${bookmarks.id} IS DISTINCT FROM ${exceptBookmarkId ?? null}::uuid))::int`,
          others: sql<number>`(count(*) FILTER (WHERE ${bookmarks.ownerId} IS DISTINCT FROM ${ownerId}::uuid AND ${bookmarks.planArchivedAt} IS NULL))::int`,
        })
        .from(bookmarks)
        .where(and(eq(bookmarks.workspaceId, workspaceId), eq(bookmarks.slug, slug)));
      if (row === undefined) {
        throw new Error("counting the use of a slug returned no row");
      }
      return { takenByOwner: row.mine > 0, othersUseCount: row.others };
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

    async fileIn({ bookmarkIds, ownerId, folderId, mode }) {
      const workspaceId = requireListWorkspace(tx, "filing bookmarks");
      requireAccountOwner(tx, ownerId, "files");
      requireIdentifiers([folderId], "filing bookmarks");
      const owned = await ownedLiveBookmarks(tx, workspaceId, ownerId, bookmarkIds, true);
      // After the bookmarks and before the first write (src/repositories/folder-links.ts): a folder that is not the owner's ends the call with nothing written.
      if (!(await lockOwnedFolders(tx, ownerId, [folderId]))) {
        return { kind: "target_not_found" };
      }
      if (mode === "remove") {
        await deleteLinks(tx, [folderId], owned);
      } else {
        if (mode === "move") {
          await deleteLinksOutside(tx, folderId, owned);
        }
        await insertLinks(tx, [folderId], owned);
      }
      return { kind: "done", affected: owned.length };
    },

    async tag({ bookmarkIds, ownerId, tagIds, mode }) {
      const workspaceId = requireListWorkspace(tx, "tagging bookmarks");
      requireAccountOwner(tx, ownerId, "tags");
      const owned = await ownedLiveBookmarks(tx, workspaceId, ownerId, bookmarkIds, true);
      // After the bookmarks and before the first write (src/repositories/tag-links.ts has the order of the locks): a tag that is not the owner's, or that a merge or a deletion has taken away, ends the call with nothing written.
      if (!(await lockTaggingTags(tx, ownerId, { ids: tagIds, names: [] }))) {
        return { kind: "target_not_found" };
      }
      if (mode === "add") {
        await insertTagLinksMany(tx, owned, tagIds);
      } else {
        await deleteTagLinksMany(tx, owned, tagIds);
      }
      return { kind: "done", affected: owned.length };
    },

    async previewTags({ bookmarkIds, ownerId, tagIds }) {
      const workspaceId = requireListWorkspace(tx, "previewing the tagging of bookmarks");
      requireAccountOwner(tx, ownerId, "previews");
      const wanted = await ownedTags(tx, ownerId, tagIds);
      if (wanted.length !== distinctIdentifiers(tagIds).length) {
        return { kind: "target_not_found" };
      }
      const owned = await ownedLiveBookmarks(tx, workspaceId, ownerId, bookmarkIds, false);
      const carried = await tagsOfBookmarks(tx, ownerId, owned);
      const preview = new Map<string, { id: string; name: string; bookmarkCount: number; added: number }>();
      for (const tag of wanted) {
        preview.set(tag.id, { ...tag, bookmarkCount: 0, added: 0 });
      }
      for (const id of owned) {
        const has = new Set<string>();
        for (const tag of carried.get(id) ?? []) {
          has.add(tag.id);
          const entry = preview.get(tag.id) ?? { ...tag, bookmarkCount: 0, added: 0 };
          entry.bookmarkCount += 1;
          preview.set(tag.id, entry);
        }
        for (const tag of wanted) {
          const entry = preview.get(tag.id);
          if (entry !== undefined && !has.has(tag.id)) {
            entry.bookmarkCount += 1;
            entry.added += 1;
          }
        }
      }
      const tags: BookmarkPreviewTag[] = [...preview.values()].toSorted((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
      return { kind: "previewed", affected: owned.length, tags };
    },

    async ids(filter, limit) {
      const workspaceId = requireListWorkspace(tx, "listing bookmark identifiers");
      if (filter.q !== undefined) {
        return (await matchedPage(tx, { filter, sort: "recent", after: undefined, limit })).page.map((row) => row.id);
      }
      if (!isOwnScope(filter)) {
        const statement = pageStatement(tx, { filter, sort: "recent", after: undefined, limit });
        return statement === undefined ? [] : (await tenantHandle(tx).execute<{ id: string }>(statement)).map((row) => row.id);
      }
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

    list: (request) => listOf(tx, request),

    count: (filter, limit) => countOf(tx, filter, limit),

    listWithCount: (request, limit) => listWithCountOf(tx, request, limit),
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
