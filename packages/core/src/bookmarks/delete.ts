import type { BookmarkStore } from "./create.ts";

// Deleting a bookmark (doc 02 section 5.3, doc 04 section 2.4, doc 10 T1 and T2). A delete is hard: the row goes, the rows that
// reference it (folder and tag links, shares, go preferences) go with it by foreign-key cascade, its slug is free in the same
// transaction and the workspace's bookmark count gives the place back unless the bookmark was plan-archived (doc 02 section
// 5.6, which lets an owner delete an archived bookmark). Only the owner deletes a bookmark. The store keeps no tombstone, so a
// delete of a bookmark that is gone, that another member owns or that belongs to another workspace is the same `false`.

export interface BookmarkDeletionDependencies {
  readonly store: Pick<BookmarkStore, "remove">;
}

export interface BookmarkDeletionAsk {
  readonly bookmarkId: string;
  /** The member who deletes the bookmark. */
  readonly accountId: string;
}

/** True when the bookmark was deleted; false when the account owns no such bookmark, which a caller must not tell apart from any other case. */
export async function deleteBookmark({ store }: BookmarkDeletionDependencies, ask: BookmarkDeletionAsk): Promise<boolean> {
  return store.remove({ bookmarkId: ask.bookmarkId, ownerId: ask.accountId.toLowerCase() });
}
