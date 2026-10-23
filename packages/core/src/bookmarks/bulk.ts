import type { AuditActor, AuditWriter } from "../audit/writer.ts";
import { bookmarkListFilter, type BookmarkFilterAsk, type BookmarkListFilter, type BookmarkScope } from "./list.ts";
import type { BookmarkUrlRefusal } from "./url.ts";

// Bulk actions on bookmarks and the select-all that feeds them (doc 02 sections 5.7 and 5.8, doc 04 sections 6.2 and 10.6, doc 05
// sections 2.2 and 3.3, doc 10 T1 and T2). A request names the caller's own bookmarks by identifier, or by the filters of the list, and
// deletes, pins or unpins them. It runs in the tenant transaction the caller already holds and opens none, so the rows, the workspace's
// `bookmark_count` and the one audit event commit or roll back together. Only the caller's own bookmarks change; every other
// identifier (another member's, another workspace's, one that is gone, and for a pin one that is plan-archived) is skipped as
// `not_found`, which no answer tells apart from another. The answer is counts only.

/** The most identifiers a bulk request names (doc 04 section 6.2). */
export const BOOKMARK_BULK_IDS_MAX = 1000;

/**
 * The most bookmarks a select-all returns and a bulk request by filter acts on (doc 02 section 16, which doc 04 section 6.2 repeats).
 * It is a fixed value of this release: doc 07 declares no key for it.
 */
export const BOOKMARK_SELECT_ALL_CAP = 5000;

export const BOOKMARK_BULK_ACTIONS = ["delete", "pin", "unpin"] as const;

export type BookmarkBulkAction = (typeof BOOKMARK_BULK_ACTIONS)[number];

export interface BookmarkBulkStore {
  /** The identifiers of the bookmarks `filter.ownerId` owns in the workspace of the transaction that match `filter` and are not plan-archived, newest first, at most `limit`. */
  ids(filter: BookmarkListFilter, limit: number): Promise<readonly string[]>;
  /**
   * Deletes the bookmarks of `bookmarkIds` that the account of the transaction owns in its workspace, a plan-archived one included, lowers the
   * workspace's `bookmark_count` once by those that were not plan-archived, and answers how many were deleted; undefined, writing nothing, when
   * the workspace cannot be reached.
   */
  removeMany(bookmarkIds: readonly string[]): Promise<number | undefined>;
  /** Pins or unpins the bookmarks of `bookmarkIds` that `ownerId` owns and that are not plan-archived, and answers how many such bookmarks there are, whether or not they were pinned already. */
  setPinned(request: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly pinned: boolean }): Promise<number>;
}

export interface BookmarkIdsDependencies {
  readonly store: Pick<BookmarkBulkStore, "ids">;
}

export interface BookmarkIdsAsk extends BookmarkFilterAsk {
  readonly scope: BookmarkScope;
}

export type BookmarkIdsOutcome =
  | { readonly kind: "listed"; readonly ids: readonly string[]; /** True when more than `BOOKMARK_SELECT_ALL_CAP` bookmarks match, so `ids` is the first of them. */ readonly truncated: boolean }
  /** The `url` filter is not a URL a bookmark can have; nothing was read. */
  | { readonly kind: "url_refused"; readonly reason: BookmarkUrlRefusal };

/** The identifiers of `ask.accountId`'s bookmarks that match the filters, up to the select-all cap. */
export async function listBookmarkIds({ store }: BookmarkIdsDependencies, ask: BookmarkIdsAsk): Promise<BookmarkIdsOutcome> {
  const parsed = bookmarkListFilter(ask);
  if (!parsed.ok) {
    return { kind: "url_refused", reason: parsed.reason };
  }
  // One more than the cap, to know whether more match.
  const found = await store.ids(parsed.filter, BOOKMARK_SELECT_ALL_CAP + 1);
  return { kind: "listed", ids: found.slice(0, BOOKMARK_SELECT_ALL_CAP), truncated: found.length > BOOKMARK_SELECT_ALL_CAP };
}

export interface BookmarkBulkDependencies {
  readonly store: BookmarkBulkStore;
  /** Writes the audit event in the same transaction. */
  readonly audit: AuditWriter;
}

export type BookmarkBulkTarget =
  | { readonly kind: "ids"; readonly ids: readonly string[] }
  | { readonly kind: "filter"; readonly scope: BookmarkScope; readonly pinned: boolean | undefined; readonly hasSlug: boolean | undefined; readonly forwarding: boolean | undefined; readonly url: string | undefined };

export interface BookmarkBulkAsk {
  /** The workspace the transaction acts in. */
  readonly workspaceId: string;
  /** The member who asks; the only owner whose bookmarks change. */
  readonly accountId: string;
  readonly actor: AuditActor;
  readonly ipPrefix: string | null;
  readonly action: BookmarkBulkAction;
  readonly target: BookmarkBulkTarget;
}

export type BookmarkBulkOutcome =
  | {
      readonly kind: "done";
      readonly requested: number;
      readonly affected: number;
      /** Always `requested - affected`, so the two reasons add up to it; `not_owner` stays 0 until bookmarks can be shared with a member. */
      readonly skipped: { readonly not_owner: number; readonly not_found: number };
    }
  /** The request names more identifiers than `BOOKMARK_BULK_IDS_MAX` or its filter matches more than `BOOKMARK_SELECT_ALL_CAP`; nothing was written. */
  | { readonly kind: "too_many"; readonly limit: number }
  /** The `url` filter is not a URL a bookmark can have; nothing was written. */
  | { readonly kind: "url_refused"; readonly reason: BookmarkUrlRefusal }
  /** The workspace of the transaction cannot be reached (it is being deleted); nothing was written. */
  | { readonly kind: "unavailable" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deletes, pins or unpins the bookmarks `ask.target` names, among the caller's own. A delete writes one `bookmark.bulk_deleted` audit event
 * with the number deleted when that is not zero. A pin or an unpin counts a bookmark that already is in the wanted state as affected and
 * leaves it untouched, so its version stays.
 */
export async function bulkBookmarks({ store, audit }: BookmarkBulkDependencies, ask: BookmarkBulkAsk): Promise<BookmarkBulkOutcome> {
  const accountId = ask.accountId.toLowerCase();
  let named: string[];
  if (ask.target.kind === "ids") {
    named = [...new Set(ask.target.ids.map((id) => id.toLowerCase()))];
    if (named.length > BOOKMARK_BULK_IDS_MAX) {
      return { kind: "too_many", limit: BOOKMARK_BULK_IDS_MAX };
    }
  } else {
    const parsed = bookmarkListFilter({ accountId, pinned: ask.target.pinned, hasSlug: ask.target.hasSlug, forwarding: ask.target.forwarding, url: ask.target.url });
    if (!parsed.ok) {
      return { kind: "url_refused", reason: parsed.reason };
    }
    // One more than the cap, to know whether more match.
    named = [...(await store.ids(parsed.filter, BOOKMARK_SELECT_ALL_CAP + 1))];
    if (named.length > BOOKMARK_SELECT_ALL_CAP) {
      return { kind: "too_many", limit: BOOKMARK_SELECT_ALL_CAP };
    }
  }
  const requested = named.length;
  const bookmarkIds = named.filter((id) => UUID.test(id));

  let affected = 0;
  if (bookmarkIds.length > 0) {
    if (ask.action === "delete") {
      const deleted = await store.removeMany(bookmarkIds);
      if (deleted === undefined) {
        return { kind: "unavailable" };
      }
      affected = deleted;
      if (deleted > 0) {
        await audit.write({
          action: "bookmark.bulk_deleted",
          workspaceId: ask.workspaceId.toLowerCase(),
          actor: ask.actor,
          metadata: { count: String(deleted) },
          ipPrefix: ask.ipPrefix,
        });
      }
    } else {
      affected = await store.setPinned({ bookmarkIds, ownerId: accountId, pinned: ask.action === "pin" });
    }
  }
  return { kind: "done", requested, affected, skipped: { not_owner: 0, not_found: requested - affected } };
}
