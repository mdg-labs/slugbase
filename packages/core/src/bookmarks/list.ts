import type { BookmarkRecord } from "./create.ts";
import { normalizeBookmarkUrl, type BookmarkUrlRefusal } from "./url.ts";

// Listing the bookmarks of a member (doc 02 section 5.7, doc 04 sections 6.1 and 6.2, doc 10 T1 and T2). A page is a slice of
// one ordering of the member's own bookmarks, resumed by an opaque cursor that carries the sort key and the identifier of the
// last item (a keyset, never an offset). The cursor is signed for the account, the workspace, the filter and the sort it was
// issued for, so it opens nothing else: a cursor of another list, another sort or another filter is refused like a forged one.
// The total is the number of bookmarks the filter matches, exact up to `BOOKMARK_LIST_TOTAL_CAP` and not counted beyond it (Q42).

export const BOOKMARK_SORTS = ["recent", "oldest", "title_asc", "title_desc", "most_used", "recently_opened"] as const;

export type BookmarkSort = (typeof BOOKMARK_SORTS)[number];

/** Where `GET /bookmarks` stops counting (Q42): above it the total is not given, only that it is at least this many. */
export const BOOKMARK_LIST_TOTAL_CAP = 10_000;

/** The bookmarks a list covers. Only the member's own exist until sharing arrives, so both scopes name the same rows today. */
export type BookmarkScope = "all" | "mine";

export interface BookmarkListFilter {
  /** The member whose bookmarks are listed. */
  readonly ownerId: string;
  /** True for pinned bookmarks only, false for unpinned only; no filter when undefined. */
  readonly pinned?: boolean | undefined;
  /** True for bookmarks with a slug only, false for those without; no filter when undefined. */
  readonly hasSlug?: boolean | undefined;
  /** True for bookmarks `/go` forwards to only, false for those it does not; no filter when undefined. */
  readonly forwarding?: boolean | undefined;
  /** The canonical form a bookmark's URL must have. */
  readonly urlCanonical?: string | undefined;
}

/** The place after which a page resumes: the sort key of the last item as the database prints it (null for a bookmark never opened) and its identifier. */
export interface BookmarkPosition {
  readonly key: string | null;
  readonly id: string;
}

export interface BookmarkListRow {
  readonly bookmark: BookmarkRecord;
  /** The sort key of `bookmark` under the sort asked for, in the form the store takes back in a `BookmarkPosition`. */
  readonly key: string | null;
}

export interface BookmarkListRequest {
  readonly filter: BookmarkListFilter;
  readonly sort: BookmarkSort;
  /** The page starts after this place; the first page when undefined. */
  readonly after: BookmarkPosition | undefined;
  readonly limit: number;
}

export interface BookmarkListStore {
  /** The next `request.limit` bookmarks of the workspace of the transaction in the order of `request.sort`, plan-archived ones never. */
  list(request: BookmarkListRequest): Promise<readonly BookmarkListRow[]>;
  /** How many bookmarks the filter matches, but at most `limit`. */
  count(filter: BookmarkListFilter, limit: number): Promise<number>;
}

/** Signs and opens cursors; a cursor opens only for the `scope` it was sealed with. */
export interface BookmarkCursors {
  seal(position: BookmarkPosition, scope: string): string;
  /** Undefined when the cursor was not sealed by this server for this scope. */
  open(cursor: string, scope: string): BookmarkPosition | undefined;
}

export interface BookmarkListDependencies {
  readonly store: BookmarkListStore;
  readonly cursors: BookmarkCursors;
}

export interface BookmarkListAsk {
  readonly workspaceId: string;
  /** The member who asks. */
  readonly accountId: string;
  readonly scope: BookmarkScope;
  readonly pinned: boolean | undefined;
  readonly hasSlug: boolean | undefined;
  readonly forwarding: boolean | undefined;
  /** A URL as typed: the list is narrowed to the bookmarks whose canonical URL is its canonical form. */
  readonly url: string | undefined;
  readonly sort: BookmarkSort;
  /** 1 to 100. */
  readonly limit: number;
  readonly cursor: string | undefined;
}

export type BookmarkListOutcome =
  | {
      readonly kind: "listed";
      readonly items: readonly BookmarkRecord[];
      readonly nextCursor: string | null;
      /** The number of matching bookmarks; null when there are more than `BOOKMARK_LIST_TOTAL_CAP`. */
      readonly total: number | null;
    }
  /** The cursor was not issued by this server for this account, workspace, filter and sort; nothing was read. */
  | { readonly kind: "bad_cursor" }
  /** The `url` filter is not a URL a bookmark can have; nothing was read. */
  | { readonly kind: "url_refused"; readonly reason: BookmarkUrlRefusal };

/** What a cursor is bound to: the list it was issued for, written so that no two different lists share a scope. */
function cursorScope(ask: BookmarkListAsk, filter: BookmarkListFilter): string {
  return JSON.stringify([ask.workspaceId.toLowerCase(), ask.accountId.toLowerCase(), ask.scope, ask.sort, filter.pinned ?? null, filter.hasSlug ?? null, filter.forwarding ?? null, filter.urlCanonical ?? null]);
}

/** The filters a list, a select-all and a bulk request take, as the caller typed them. */
export interface BookmarkFilterAsk {
  /** The member whose bookmarks are matched. */
  readonly accountId: string;
  readonly pinned: boolean | undefined;
  readonly hasSlug: boolean | undefined;
  readonly forwarding: boolean | undefined;
  /** A URL as typed: the match is narrowed to the bookmarks whose canonical URL is its canonical form. */
  readonly url: string | undefined;
}

/** The store's filter for `ask`, or the reason its `url` cannot be a bookmark's URL. */
export function bookmarkListFilter(ask: BookmarkFilterAsk): { readonly ok: true; readonly filter: BookmarkListFilter } | { readonly ok: false; readonly reason: BookmarkUrlRefusal } {
  let urlCanonical: string | undefined;
  if (ask.url !== undefined) {
    const normalized = normalizeBookmarkUrl(ask.url);
    if (!normalized.ok) {
      return { ok: false, reason: normalized.reason };
    }
    urlCanonical = normalized.value.canonical;
  }
  return { ok: true, filter: { ownerId: ask.accountId, pinned: ask.pinned, hasSlug: ask.hasSlug, forwarding: ask.forwarding, urlCanonical } };
}

/** One page of `ask.accountId`'s bookmarks in the workspace of the transaction, with the cursor of the next and the capped total. */
export async function listBookmarks({ store, cursors }: BookmarkListDependencies, ask: BookmarkListAsk): Promise<BookmarkListOutcome> {
  const parsed = bookmarkListFilter(ask);
  if (!parsed.ok) {
    return { kind: "url_refused", reason: parsed.reason };
  }
  const filter = parsed.filter;
  const scope = cursorScope(ask, filter);
  let after: BookmarkPosition | undefined;
  if (ask.cursor !== undefined) {
    after = cursors.open(ask.cursor, scope);
    if (after === undefined) {
      return { kind: "bad_cursor" };
    }
  }
  // One more than the page, to know whether another page follows.
  const fetched = await store.list({ filter, sort: ask.sort, after, limit: ask.limit + 1 });
  const rows = fetched.slice(0, ask.limit);
  const last = rows.at(-1);
  const counted = await store.count(filter, BOOKMARK_LIST_TOTAL_CAP + 1);
  return {
    kind: "listed",
    items: rows.map((row) => row.bookmark),
    nextCursor: fetched.length > ask.limit && last !== undefined ? cursors.seal({ key: last.key, id: last.bookmark.id }, scope) : null,
    total: counted > BOOKMARK_LIST_TOTAL_CAP ? null : counted,
  };
}
