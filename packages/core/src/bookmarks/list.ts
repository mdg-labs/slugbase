import { normalizeSearchQuery } from "../search/search.ts";
import type { BookmarkRecord } from "./create.ts";
import { normalizeBookmarkUrl, type BookmarkUrlRefusal } from "./url.ts";

// Listing the bookmarks of a member (doc 02 sections 5.7 and 8.2, doc 04 sections 6.1 and 6.2, doc 10 T1 and T2). A page is a slice of
// one ordering of the bookmarks the member's scope covers (their own, the ones shared with them, the ones they share, or the first and the second together),
// resumed by an opaque cursor that carries the sort key and the identifier of the
// last item (a keyset, never an offset). The cursor is signed for the account, the workspace, the filter and the sort it was
// issued for, so it opens nothing else: a cursor of another list, another sort or another filter is refused like a forged one.
// The total is the number of bookmarks the filter matches, exact up to `BOOKMARK_LIST_TOTAL_CAP` and not counted beyond it (Q42).

export const BOOKMARK_SORTS = ["recent", "oldest", "title_asc", "title_desc", "most_used", "recently_opened"] as const;

export type BookmarkSort = (typeof BOOKMARK_SORTS)[number];

/** Where `GET /bookmarks` stops counting (Q42): above it the total is not given, only that it is at least this many. */
export const BOOKMARK_LIST_TOTAL_CAP = 10_000;

/**
 * The bookmarks a list covers: `mine` the member's own, `shared_with_me` those of other members that are shared with them (directly, through a team or through a folder),
 * `shared_by_me` the member's own that are shared with anyone, and `all` the first and the second kind together. A bookmark that can be read through more than one route
 * is listed once, and a plan-archived one never.
 */
export const BOOKMARK_SCOPES = ["all", "mine", "shared_with_me", "shared_by_me"] as const;

export type BookmarkScope = (typeof BOOKMARK_SCOPES)[number];

export interface BookmarkListFilter {
  /** The member who lists: the owner of the bookmarks of the `mine` and `shared_by_me` scopes and the one the others are shared with. */
  readonly ownerId: string;
  /**
   * Which bookmarks the member's list covers; `mine` when undefined. Filters that name the member's own things (`folderId`, `tagIds`, `urlCanonical`) reach
   * the member's own bookmarks alone, since a bookmark shared with them is filed in none of their folders and carries none of their tags.
   */
  readonly scope?: BookmarkScope | undefined;
  /** True for pinned bookmarks only, false for unpinned only; no filter when undefined. */
  readonly pinned?: boolean | undefined;
  /** True for bookmarks with a slug only, false for those without; no filter when undefined. */
  readonly hasSlug?: boolean | undefined;
  /** True for bookmarks `/go` forwards to only, false for those it does not; no filter when undefined. */
  readonly forwarding?: boolean | undefined;
  /** The canonical form a bookmark's URL must have. */
  readonly urlCanonical?: string | undefined;
  /** The folder the bookmark must be filed in. A folder the member does not own matches nothing. */
  readonly folderId?: string | undefined;
  /** The tags the bookmark must carry, all of them (AND), as identifiers without repeats in a stable order. A tag the member does not own matches nothing. */
  readonly tagIds?: readonly string[] | undefined;
  /** The text the bookmark must match: its slug, title, host and description, as the search of doc 02 section 9.1 matches them. The text is normalised as the search normalises its query (control characters, which the database refuses, taken out as white space, runs of white space made one, the length capped), so the list and the search agree on what a query finds. A blank text, and one left blank by that, matches no bookmark, so a filter that has lost its text never widens a list or a bulk action. */
  readonly q?: string | undefined;
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

/** A page of a list together with how many bookmarks its filter matches, at most the limit the page was asked with. */
export interface BookmarkListPage {
  readonly rows: readonly BookmarkListRow[];
  readonly count: number;
}

export interface BookmarkListStore {
  /** The next `request.limit` bookmarks of the workspace of the transaction in the order of `request.sort`, plan-archived ones never. */
  list(request: BookmarkListRequest): Promise<readonly BookmarkListRow[]>;
  /** How many bookmarks the filter matches, but at most `limit`. */
  count(filter: BookmarkListFilter, limit: number): Promise<number>;
  /** What `list(request)` answers and what `count(request.filter, limit)` answers, read together so that a store can share the work of the two. */
  listWithCount(request: BookmarkListRequest, limit: number): Promise<BookmarkListPage>;
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
  /** The list is narrowed to the bookmarks filed in this folder of the member's; an empty page for any other folder. */
  readonly folderId?: string | undefined;
  /** The list is narrowed to the bookmarks that carry every one of these tags of the member's; an empty page when one is not the member's. */
  readonly tagIds?: readonly string[] | undefined;
  /** The list is narrowed to the bookmarks that match this text, without the whitespace around it; a blank text matches nothing (the contract refuses one). */
  readonly q?: string | undefined;
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
  return JSON.stringify([ask.workspaceId.toLowerCase(), ask.accountId.toLowerCase(), ask.scope, ask.sort, filter.pinned ?? null, filter.hasSlug ?? null, filter.forwarding ?? null, filter.urlCanonical ?? null, filter.folderId ?? null, filter.tagIds ?? [], filter.q ?? null]);
}

/** The filters a list, a select-all and a bulk request take, as the caller typed them. */
export interface BookmarkFilterAsk {
  /** The member whose bookmarks are matched. */
  readonly accountId: string;
  /** Which bookmarks are matched; the member's own when left out. */
  readonly scope?: BookmarkScope | undefined;
  readonly pinned: boolean | undefined;
  readonly hasSlug: boolean | undefined;
  readonly forwarding: boolean | undefined;
  /** A URL as typed: the match is narrowed to the bookmarks whose canonical URL is its canonical form. */
  readonly url: string | undefined;
  /** The match is narrowed to the bookmarks filed in this folder of the member's. */
  readonly folderId?: string | undefined;
  /** The match is narrowed to the bookmarks that carry every one of these tags of the member's. */
  readonly tagIds?: readonly string[] | undefined;
  /** The match is narrowed to the bookmarks that match this text, without the whitespace around it; a blank text matches nothing (the contract refuses one). */
  readonly q?: string | undefined;
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
  return {
    ok: true,
    filter: {
      ownerId: ask.accountId,
      scope: ask.scope,
      pinned: ask.pinned,
      hasSlug: ask.hasSlug,
      forwarding: ask.forwarding,
      urlCanonical,
      folderId: ask.folderId === undefined ? undefined : ask.folderId.toLowerCase(),
      tagIds: ask.tagIds === undefined ? undefined : [...new Set(ask.tagIds.map((id) => id.toLowerCase()))].sort(),
      q: ask.q === undefined ? undefined : normalizeSearchQuery(ask.q),
    },
  };
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
  const { rows: fetched, count: counted } = await store.listWithCount({ filter, sort: ask.sort, after, limit: ask.limit + 1 }, BOOKMARK_LIST_TOTAL_CAP + 1);
  const rows = fetched.slice(0, ask.limit);
  const last = rows.at(-1);
  return {
    kind: "listed",
    items: rows.map((row) => row.bookmark),
    nextCursor: fetched.length > ask.limit && last !== undefined ? cursors.seal({ key: last.key, id: last.bookmark.id }, scope) : null,
    total: counted > BOOKMARK_LIST_TOTAL_CAP ? null : counted,
  };
}
