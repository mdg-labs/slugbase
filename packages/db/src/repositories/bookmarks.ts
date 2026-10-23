import type { BookmarkRecord, NewBookmark } from "@slugbase/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { bookmarks } from "../schema/bookmarks.ts";
import { enqueueInTenantTransaction, type QueuedJob } from "../system/queue.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { defineScopedRepository } from "./scoped.ts";

// The bookmarks of the active workspace (doc 05 section 2.4, doc 02 section 5, doc 10 T1, T2 and T11). Reads and the insert go
// through the scoped repositories below, so every statement carries the workspace of the transaction and runs on the policies
// of `bookmarks` on top of that; `slugbase_app` may select and insert and nothing else, which is why the repositories have
// no other method. A bookmark that is plan-archived is not one the product shows, so a lookup leaves it out. The place under
// `bookmarks.max` is taken by the system operation `sys_bookmark_count_take`, which locks the workspace's row, compares the
// workspace's `bookmark_count` with the ceiling and raises it, in the transaction that inserts the bookmark: a failed
// insert takes the place back with it, and two creations at the limit minus one make one.

// `slugbase_app` may insert only the columns a request gives a new bookmark (src/sql/470-bookmarks.sql): not the slug, forwarding,
// the archive state, the usage or the version, so a row it writes is never archived or forwarding and starts unused.
const scoped = defineScopedRepository("bookmarks", bookmarks, {
  methods: ["select", "insert"],
  insertColumns: ["id", "ownerId", "url", "urlCanonical", "host", "title", "description", "pinnedAt"],
});

type BookmarkRow = InferSelectModel<typeof bookmarks>;

interface TakenRow extends Record<string, unknown> {
  outcome: string;
  used: number | null;
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
  };
}
