import type { BookmarkRecord, BookmarkStore } from "./create.ts";

// Reading one bookmark (doc 04 section 10.6, doc 05 sections 2.4 and 4, doc 02 section 8.2, doc 10 T1 and T2). Read access comes from the access predicate
// of doc 05 section 4, which the store applies: the owner reads their bookmark, and so does a member it is shared with, directly, through a team or through
// a folder. The record a recipient gets names the owner and how the bookmark is shared with them, and carries nothing of the owner's folders, tags or pin.
// Another member's bookmark that is not shared with the account, one of another workspace and one that does not exist are the same undefined, and the
// store never sees a bookmark of another workspace at all.

export interface BookmarkReadDependencies {
  readonly store: Pick<BookmarkStore, "find">;
}

export interface BookmarkReadAsk {
  readonly bookmarkId: string;
  /** The member who asks. */
  readonly accountId: string;
}

/**
 * The bookmark `ask.bookmarkId` when the account can read it; undefined for every other case, which a caller must not tell apart. The store reads for the account of its
 * transaction, which is `ask.accountId`; a record that is not shared with the asker and is not theirs is not one they can read, whatever a store answered.
 */
export async function readBookmark({ store }: BookmarkReadDependencies, ask: BookmarkReadAsk): Promise<BookmarkRecord | undefined> {
  const bookmark = await store.find(ask.bookmarkId);
  return bookmark !== undefined && (bookmark.sharedVia !== null || bookmark.ownerId === ask.accountId.toLowerCase()) ? bookmark : undefined;
}
