import type { BookmarkRecord, BookmarkUpdateRequest, BookmarkUpdateResult, NewBookmark } from "@slugbase/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
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
// insert takes the place back with it, and two creations at the limit minus one make one.

// `slugbase_app` may insert only the columns a request gives a new bookmark and update only the columns a change of its own fields
// writes (src/sql/470-bookmarks.sql): not the slug, forwarding, the archive state, the usage, the owner or the version, so a row
// it writes is never archived or forwarding and starts unused, and its version is moved by the trigger and by nothing it sends.
const scoped = defineScopedRepository("bookmarks", bookmarks, {
  methods: ["select", "insert", "update"],
  insertColumns: ["id", "ownerId", "url", "urlCanonical", "host", "title", "description", "pinnedAt"],
  updateColumns: ["url", "urlCanonical", "host", "title", "description", "pinnedAt"],
});

type BookmarkRow = InferSelectModel<typeof bookmarks>;

interface TakenRow extends Record<string, unknown> {
  outcome: string;
  used: number | null;
}

interface DeletedRow extends Record<string, unknown> {
  deleted: boolean | null;
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
}

function recordOf(row: BookmarkRow): BookmarkRecord {
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
  };
}
