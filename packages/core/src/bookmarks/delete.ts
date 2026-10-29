import type { BookmarkStore } from "./create.ts";

// Deleting a bookmark (doc 02 section 5.3, doc 04 section 2.4, doc 10 T1 and T2). A delete is hard: the row goes, the rows that
// reference it (folder and tag links, shares, go preferences) go with it by foreign-key cascade, its slug is free in the same
// transaction and the workspace's bookmark count gives the place back unless the bookmark was plan-archived (doc 02 section
// 5.6, which lets an owner delete an archived bookmark). Only the owner deletes a bookmark. The store keeps no tombstone, so a
// delete of a bookmark that is gone, that another member owns and has not shared with the caller, or that belongs to another workspace is the same
// `not_found`; a bookmark that is shared with the caller is one they can read and not delete, which is `forbidden` (doc 02 section 8.2, Q22).

export interface BookmarkDeletionDependencies {
  readonly store: Pick<BookmarkStore, "remove" | "sharedWith">;
}

export interface BookmarkDeletionAsk {
  readonly bookmarkId: string;
  /** The member who deletes the bookmark. */
  readonly accountId: string;
}

export type BookmarkDeletionOutcome =
  | { readonly kind: "deleted" }
  /** The account can read the bookmark and does not own it; nothing was deleted. */
  | { readonly kind: "forbidden" }
  /** The account owns no such bookmark and can read none; which of the reasons it is stays unsaid. */
  | { readonly kind: "not_found" };

export async function deleteBookmark({ store }: BookmarkDeletionDependencies, ask: BookmarkDeletionAsk): Promise<BookmarkDeletionOutcome> {
  const accountId = ask.accountId.toLowerCase();
  if (await store.remove({ bookmarkId: ask.bookmarkId, ownerId: accountId })) {
    return { kind: "deleted" };
  }
  return (await store.sharedWith({ bookmarkId: ask.bookmarkId, accountId })) ? { kind: "forbidden" } : { kind: "not_found" };
}
