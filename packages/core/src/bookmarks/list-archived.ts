import { BOOKMARK_LIST_TOTAL_CAP, type BookmarkCursors } from "./list.ts";
import type { BookmarkRecord } from "./create.ts";

// Listing the plan-archived bookmarks of a member (doc 02 section 5.6, doc 03 section 3.6, doc 04 section 6.1, doc 10 T1 and T2). A bookmark that a composition's plan
// limit archived leaves every other read of the product, and its owner alone may see, export and delete it, so this list is the member's own archived bookmarks of the
// workspace and nothing else: never a bookmark that is not archived, never another member's and never another workspace's. A page is a slice of one ordering, the most
// recently archived first with the identifier as the tiebreak, resumed by an opaque cursor that carries the instant the last item was archived (as the database prints it) and
// its identifier. The cursor is signed for the account and the workspace it was issued for and for this list, so it opens nothing else; the cursor of another list is refused like
// a forged one. The total is the number of archived bookmarks the member owns, exact up to `BOOKMARK_LIST_TOTAL_CAP` (Q42).

/** A plan-archived bookmark with the instant it was archived. */
export interface ArchivedBookmarkRow {
  readonly bookmark: BookmarkRecord;
  readonly archivedAt: Date;
  /** `archivedAt` in the form the store takes back in a `BookmarkPosition`: the instant as the database prints it, which keeps the precision a `Date` loses. */
  readonly key: string;
}

/** The place after which a page resumes: the instant the last item was archived, as the database prints it, and its identifier. */
export interface ArchivedBookmarkPosition {
  readonly key: string;
  readonly id: string;
}

export interface ArchivedBookmarkListRequest {
  /** The page starts after this place; the first page when undefined. */
  readonly after: ArchivedBookmarkPosition | undefined;
  readonly limit: number;
}

export interface ArchivedBookmarkStore {
  /** The next `request.limit` plan-archived bookmarks that the account of the transaction owns in the workspace of the transaction, the most recently archived first and the identifier as the tiebreak. */
  listArchived(request: ArchivedBookmarkListRequest): Promise<readonly ArchivedBookmarkRow[]>;
  /** How many such bookmarks there are, but at most `limit`. */
  countArchived(limit: number): Promise<number>;
}

export interface ArchivedBookmarkListDependencies {
  readonly store: ArchivedBookmarkStore;
  readonly cursors: BookmarkCursors;
}

export interface ArchivedBookmarkListAsk {
  readonly workspaceId: string;
  /** The member who asks, whose own archived bookmarks are listed. */
  readonly accountId: string;
  /** 1 to 100. */
  readonly limit: number;
  readonly cursor: string | undefined;
}

export type ArchivedBookmarkListOutcome =
  | {
      readonly kind: "listed";
      readonly items: readonly ArchivedBookmarkRow[];
      readonly nextCursor: string | null;
      /** The number of archived bookmarks the member owns; null when there are more than `BOOKMARK_LIST_TOTAL_CAP`. */
      readonly total: number | null;
    }
  /** The cursor was not issued by this server for this account and workspace and this list; nothing was read. */
  | { readonly kind: "bad_cursor" };

/** What a cursor of this list is bound to: the list, the workspace and the account, written so that no cursor of the list of all bookmarks shares it. */
function cursorScope(ask: ArchivedBookmarkListAsk): string {
  return JSON.stringify(["archived", ask.workspaceId.toLowerCase(), ask.accountId.toLowerCase()]);
}

/** One page of the plan-archived bookmarks of `ask.accountId` in the workspace of the transaction, with the cursor of the next and the capped total. */
export async function listArchivedBookmarks({ store, cursors }: ArchivedBookmarkListDependencies, ask: ArchivedBookmarkListAsk): Promise<ArchivedBookmarkListOutcome> {
  const scope = cursorScope(ask);
  let after: ArchivedBookmarkPosition | undefined;
  if (ask.cursor !== undefined) {
    const opened = cursors.open(ask.cursor, scope);
    // Every item of this list has an archive instant, so a cursor without one was not issued for it.
    if (opened === undefined || opened.key === null) {
      return { kind: "bad_cursor" };
    }
    after = { key: opened.key, id: opened.id };
  }
  // One more than the page, to know whether another page follows.
  const fetched = await store.listArchived({ after, limit: ask.limit + 1 });
  const counted = await store.countArchived(BOOKMARK_LIST_TOTAL_CAP + 1);
  const rows = fetched.slice(0, ask.limit);
  const last = rows.at(-1);
  return {
    kind: "listed",
    items: rows,
    nextCursor: fetched.length > ask.limit && last !== undefined ? cursors.seal({ key: last.key, id: last.bookmark.id }, scope) : null,
    total: counted > BOOKMARK_LIST_TOTAL_CAP ? null : counted,
  };
}
