import type { BookmarkRecord, BookmarkStore } from "./create.ts";

// Reading one bookmark (doc 04 section 10.6, doc 05 section 2.4, doc 10 T1 and T2). The store finds a bookmark of the
// workspace of the transaction by identifier, whoever owns it; this decides whether the account may read it. Read access
// comes from ownership, so another member's bookmark of the same workspace is answered like one that does not exist, and
// the store never sees a bookmark of another workspace at all.

export interface BookmarkReadDependencies {
  readonly store: Pick<BookmarkStore, "find">;
}

export interface BookmarkReadAsk {
  readonly bookmarkId: string;
  /** The member who asks. */
  readonly accountId: string;
}

/** The bookmark `ask.bookmarkId` when the account owns it; undefined for every other case, which a caller must not tell apart. */
export async function readBookmark({ store }: BookmarkReadDependencies, ask: BookmarkReadAsk): Promise<BookmarkRecord | undefined> {
  const bookmark = await store.find(ask.bookmarkId);
  return bookmark !== undefined && bookmark.ownerId === ask.accountId.toLowerCase() ? bookmark : undefined;
}
