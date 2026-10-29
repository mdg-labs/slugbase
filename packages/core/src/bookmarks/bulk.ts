import type { AuditActor, AuditWriter } from "../audit/writer.ts";
import { bookmarkListFilter, type BookmarkFilterAsk, type BookmarkListFilter, type BookmarkScope } from "./list.ts";
import type { BookmarkUrlRefusal } from "./url.ts";

// Bulk actions on bookmarks and the select-all that feeds them (doc 02 sections 5.7 and 5.8, doc 04 sections 6.2 and 10.6, doc 05
// sections 2.2 and 3.3, doc 10 T1 and T2). A request names the caller's own bookmarks by identifier, or by the filters of the list, and
// deletes, pins, unpins, files or tags them. It runs in the tenant transaction the caller already holds and opens none, so the rows, the
// links, the workspace's `bookmark_count` and the one audit event commit or roll back together. Only the caller's own bookmarks change;
// every other identifier (another member's, another workspace's, one that is gone, and for every action but a delete one that is
// plan-archived) is skipped as `not_found`, which no answer tells apart from another. The folder a filing acts with and the tags a tagging
// acts with are the caller's own too: one that is not is `target_not_found` and nothing is written. A selection that holds a bookmark the caller can read because it is
// shared with them is one they cannot act on (doc 02 sections 5.8 and 8.2, Q22): the whole request is `forbidden` and nothing is written, whichever action it asks for.
// The answer is counts only.

/** The most identifiers a bulk request names (doc 04 section 6.2). */
export const BOOKMARK_BULK_IDS_MAX = 1000;

/**
 * The most bookmarks a select-all returns and a bulk request by filter acts on (doc 02 section 16, which doc 04 section 6.2 repeats).
 * It is a fixed value of this release: doc 07 declares no key for it.
 */
export const BOOKMARK_SELECT_ALL_CAP = 5000;

export const BOOKMARK_BULK_FOLDER_ACTIONS = ["add_to_folder", "move_to_folder", "remove_from_folder"] as const;

export const BOOKMARK_BULK_TAG_ACTIONS = ["add_tags", "remove_tags"] as const;

export const BOOKMARK_BULK_ACTIONS = ["delete", "pin", "unpin", ...BOOKMARK_BULK_FOLDER_ACTIONS, ...BOOKMARK_BULK_TAG_ACTIONS] as const;

export type BookmarkBulkAction = (typeof BOOKMARK_BULK_ACTIONS)[number];

/** How a filing treats the folders a bookmark is in besides the target: `add` keeps them, `move` leaves them, and `remove` takes the bookmark out of the target alone. */
export type BookmarkFilingMode = "add" | "move" | "remove";

export type BookmarkTaggingMode = "add" | "remove";

/** What a filing or a tagging answers: the number of bookmarks it reached, or that its folder or one of its tags is not the owner's, with nothing written. */
export type BookmarkLinkingResult = { readonly kind: "done"; readonly affected: number } | { readonly kind: "target_not_found" };

/** A tag of the preview of adding tags, with how many of the bookmarks reached carry it afterwards and how many of them get it. */
export interface BookmarkPreviewTag {
  readonly id: string;
  readonly name: string;
  readonly bookmarkCount: number;
  readonly added: number;
}

export type BookmarkTagPreviewResult =
  | { readonly kind: "previewed"; readonly affected: number; readonly tags: readonly BookmarkPreviewTag[] }
  | { readonly kind: "target_not_found" };

export interface BookmarkBulkStore {
  /** The identifiers of the bookmarks of the scope of `filter` (`filter.ownerId`'s own unless the filter says more) in the workspace of the transaction that match `filter` and are not plan-archived, newest first, at most `limit`. */
  ids(filter: BookmarkListFilter, limit: number): Promise<readonly string[]>;
  /** Those of `bookmarkIds` that are shared with `accountId` (the account of the transaction): readable by it through a share, owned by someone else, not plan-archived. */
  sharedAmong(request: { readonly bookmarkIds: readonly string[]; readonly accountId: string }): Promise<readonly string[]>;
  /**
   * Deletes the bookmarks of `bookmarkIds` that the account of the transaction owns in its workspace, a plan-archived one included, lowers the
   * workspace's `bookmark_count` once by those that were not plan-archived, and answers how many were deleted; undefined, writing nothing, when
   * the workspace cannot be reached.
   */
  removeMany(bookmarkIds: readonly string[]): Promise<number | undefined>;
  /** Pins or unpins the bookmarks of `bookmarkIds` that `ownerId` owns and that are not plan-archived, and answers how many such bookmarks there are, whether or not they were pinned already. */
  setPinned(request: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly pinned: boolean }): Promise<number>;
  /**
   * Files the bookmarks of `bookmarkIds` that `ownerId` owns and that are not plan-archived in the folder `folderId` of the owner's (`add`), in that folder alone
   * (`move`), or takes them out of it (`remove`), and answers how many such bookmarks there are, whether or not they were filed so already. A folder that is not the
   * owner's is `target_not_found`, with nothing written.
   */
  fileIn(request: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly folderId: string; readonly mode: BookmarkFilingMode }): Promise<BookmarkLinkingResult>;
  /**
   * Puts the tags `tagIds` of `ownerId` on the bookmarks of `bookmarkIds` that the owner owns and that are not plan-archived (`add`), or takes them off (`remove`), and answers
   * how many such bookmarks there are, whether or not they carried the tags already. A tag that is not the owner's is `target_not_found`, with nothing written.
   */
  tag(request: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly tagIds: readonly string[]; readonly mode: BookmarkTaggingMode }): Promise<BookmarkLinkingResult>;
  /** What `tag` with `add` would leave on the same bookmarks, without writing: how many it reaches and the tag set they would carry. */
  previewTags(request: { readonly bookmarkIds: readonly string[]; readonly ownerId: string; readonly tagIds: readonly string[] }): Promise<BookmarkTagPreviewResult>;
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
  | {
      readonly kind: "filter";
      readonly scope: BookmarkScope;
      readonly pinned: boolean | undefined;
      readonly hasSlug: boolean | undefined;
      readonly forwarding: boolean | undefined;
      readonly url: string | undefined;
      /** The folder the bookmarks must be filed in, as the list takes it. */
      readonly folderId?: string | undefined;
      /** The tags the bookmarks must carry, all of them, as the list takes them. */
      readonly tagIds?: readonly string[] | undefined;
      /** The text the bookmarks must match, as the list takes it. */
      readonly q?: string | undefined;
    };

export interface BookmarkBulkAsk {
  /** The workspace the transaction acts in. */
  readonly workspaceId: string;
  /** The member who asks; the only owner whose bookmarks change. */
  readonly accountId: string;
  readonly actor: AuditActor;
  readonly ipPrefix: string | null;
  readonly action: BookmarkBulkAction;
  readonly target: BookmarkBulkTarget;
  /** The caller's folder a folder action acts with; the contract requires it for those and refuses it for the rest. */
  readonly folderId?: string | undefined;
  /** The caller's tags a tag action acts with; the contract requires them for those and refuses them for the rest. */
  readonly tagIds?: readonly string[] | undefined;
}

export type BookmarkBulkOutcome =
  | {
      readonly kind: "done";
      readonly requested: number;
      readonly affected: number;
      /** Always `requested - affected`, so the two reasons add up to it; `not_owner` stays 0, since a selection that holds a bookmark shared with the caller is refused as a whole. */
      readonly skipped: { readonly not_owner: number; readonly not_found: number };
    }
  /** The request names more identifiers than `BOOKMARK_BULK_IDS_MAX` or its filter matches more than `BOOKMARK_SELECT_ALL_CAP`; nothing was written. */
  | { readonly kind: "too_many"; readonly limit: number }
  /** The `url` filter is not a URL a bookmark can have; nothing was written. */
  | { readonly kind: "url_refused"; readonly reason: BookmarkUrlRefusal }
  /** The workspace of the transaction cannot be reached (it is being deleted); nothing was written. */
  | { readonly kind: "unavailable" }
  /** The selection holds a bookmark that is shared with the caller, whom a share gives read access only; nothing was written. */
  | { readonly kind: "forbidden" }
  /** The folder of a folder action or a tag of a tag action is not one the caller has (another member's, another workspace's or unknown); nothing was written. */
  | { readonly kind: "target_not_found" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The identifiers a request acts on, without repeats and lower-cased, or why it cannot be answered. */
type NamedBookmarks =
  | { readonly kind: "named"; readonly named: readonly string[] }
  | { readonly kind: "too_many"; readonly limit: number }
  | { readonly kind: "url_refused"; readonly reason: BookmarkUrlRefusal };

async function namedBookmarks(store: Pick<BookmarkBulkStore, "ids">, accountId: string, target: BookmarkBulkTarget): Promise<NamedBookmarks> {
  if (target.kind === "ids") {
    const named = [...new Set(target.ids.map((id) => id.toLowerCase()))];
    return named.length > BOOKMARK_BULK_IDS_MAX ? { kind: "too_many", limit: BOOKMARK_BULK_IDS_MAX } : { kind: "named", named };
  }
  const parsed = bookmarkListFilter({ accountId, scope: target.scope, pinned: target.pinned, hasSlug: target.hasSlug, forwarding: target.forwarding, url: target.url, folderId: target.folderId, tagIds: target.tagIds, q: target.q });
  if (!parsed.ok) {
    return { kind: "url_refused", reason: parsed.reason };
  }
  // One more than the cap, to know whether more match.
  const named = [...(await store.ids(parsed.filter, BOOKMARK_SELECT_ALL_CAP + 1))];
  return named.length > BOOKMARK_SELECT_ALL_CAP ? { kind: "too_many", limit: BOOKMARK_SELECT_ALL_CAP } : { kind: "named", named };
}

const FILING_MODES = { add_to_folder: "add", move_to_folder: "move", remove_from_folder: "remove" } as const satisfies Record<(typeof BOOKMARK_BULK_FOLDER_ACTIONS)[number], BookmarkFilingMode>;

const TAGGING_MODES = { add_tags: "add", remove_tags: "remove" } as const satisfies Record<(typeof BOOKMARK_BULK_TAG_ACTIONS)[number], BookmarkTaggingMode>;

function requiredFolder(folderId: string | undefined): string {
  if (folderId === undefined) {
    throw new RangeError("a folder action names a folder");
  }
  return folderId.toLowerCase();
}

function requiredTags(tagIds: readonly string[] | undefined): string[] {
  if (tagIds === undefined || tagIds.length === 0) {
    throw new RangeError("a tag action names tags");
  }
  return [...new Set(tagIds.map((id) => id.toLowerCase()))];
}

/**
 * Deletes, pins, unpins, files or tags the bookmarks `ask.target` names, among the caller's own. A delete writes one `bookmark.bulk_deleted` audit event
 * with the number deleted when that is not zero. A pin, an unpin, a filing or a tagging counts a bookmark that already is in the wanted state as affected
 * and leaves it untouched, so its version stays; filing and tagging move no version at all. The folder or the tags are checked even when no bookmark is
 * reached, so the same request is refused whatever the bookmarks.
 */
export async function bulkBookmarks({ store, audit }: BookmarkBulkDependencies, ask: BookmarkBulkAsk): Promise<BookmarkBulkOutcome> {
  const accountId = ask.accountId.toLowerCase();
  const target = await namedBookmarks(store, accountId, ask.target);
  if (target.kind !== "named") {
    return target;
  }
  const requested = target.named.length;
  const bookmarkIds = target.named.filter((id) => UUID.test(id));
  if (bookmarkIds.length > 0 && (await store.sharedAmong({ bookmarkIds, accountId })).length > 0) {
    return { kind: "forbidden" };
  }

  let affected = 0;
  if (ask.action === "delete") {
    if (bookmarkIds.length > 0) {
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
    }
  } else if (ask.action === "pin" || ask.action === "unpin") {
    if (bookmarkIds.length > 0) {
      affected = await store.setPinned({ bookmarkIds, ownerId: accountId, pinned: ask.action === "pin" });
    }
  } else if (ask.action === "add_tags" || ask.action === "remove_tags") {
    const linked = await store.tag({ bookmarkIds, ownerId: accountId, tagIds: requiredTags(ask.tagIds), mode: TAGGING_MODES[ask.action] });
    if (linked.kind === "target_not_found") {
      return linked;
    }
    affected = linked.affected;
  } else {
    const linked = await store.fileIn({ bookmarkIds, ownerId: accountId, folderId: requiredFolder(ask.folderId), mode: FILING_MODES[ask.action] });
    if (linked.kind === "target_not_found") {
      return linked;
    }
    affected = linked.affected;
  }
  return { kind: "done", requested, affected, skipped: { not_owner: 0, not_found: requested - affected } };
}

export interface BookmarkBulkPreviewDependencies {
  readonly store: Pick<BookmarkBulkStore, "ids" | "previewTags" | "sharedAmong">;
}

export interface BookmarkBulkPreviewAsk {
  /** The member who asks; the only owner whose bookmarks the preview counts. */
  readonly accountId: string;
  readonly target: BookmarkBulkTarget;
  /** The caller's tags `add_tags` would put on the bookmarks. */
  readonly tagIds: readonly string[];
}

export type BookmarkBulkPreviewOutcome =
  | {
      readonly kind: "previewed";
      readonly requested: number;
      readonly affected: number;
      readonly skipped: { readonly not_owner: number; readonly not_found: number };
      readonly tags: readonly BookmarkPreviewTag[];
    }
  /** The request names more identifiers than `BOOKMARK_BULK_IDS_MAX` or its filter matches more than `BOOKMARK_SELECT_ALL_CAP`. */
  | { readonly kind: "too_many"; readonly limit: number }
  /** The `url` filter is not a URL a bookmark can have. */
  | { readonly kind: "url_refused"; readonly reason: BookmarkUrlRefusal }
  /** The selection holds a bookmark that is shared with the caller, who may not tag it. */
  | { readonly kind: "forbidden" }
  /** A tag is not one the caller has (another member's, another workspace's or unknown). */
  | { readonly kind: "target_not_found" };

/** What `bulkBookmarks` with `add_tags` would do to the same target, counted the same way and without writing: the tag set the bookmarks it reaches would carry. */
export async function previewBulkTags({ store }: BookmarkBulkPreviewDependencies, ask: BookmarkBulkPreviewAsk): Promise<BookmarkBulkPreviewOutcome> {
  const accountId = ask.accountId.toLowerCase();
  const target = await namedBookmarks(store, accountId, ask.target);
  if (target.kind !== "named") {
    return target;
  }
  const requested = target.named.length;
  const bookmarkIds = target.named.filter((id) => UUID.test(id));
  if (bookmarkIds.length > 0 && (await store.sharedAmong({ bookmarkIds, accountId })).length > 0) {
    return { kind: "forbidden" };
  }
  const previewed = await store.previewTags({ bookmarkIds, ownerId: accountId, tagIds: requiredTags(ask.tagIds) });
  if (previewed.kind === "target_not_found") {
    return previewed;
  }
  return { kind: "previewed", requested, affected: previewed.affected, skipped: { not_owner: 0, not_found: requested - previewed.affected }, tags: previewed.tags };
}
