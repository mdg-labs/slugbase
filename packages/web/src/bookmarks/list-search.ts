import { useNavigate, useSearch } from "@tanstack/react-router";

/** The orders the list offers, from the API's `sort` parameter (doc 02 section 5.7). */
export const BOOKMARK_SORTS = ["recent", "oldest", "title_asc", "title_desc", "most_used", "recently_opened"] as const;

export type BookmarkSort = (typeof BOOKMARK_SORTS)[number];

/** How many bookmarks each load adds (doc 02 section 5.7); the choice is the `limit` of the request. */
export const BOOKMARK_PAGE_SIZES = [24, 48, 96] as const;

export type BookmarkPageSize = (typeof BOOKMARK_PAGE_SIZES)[number];

export type BookmarkView = "grid" | "table";

export type BookmarkScope = "all" | "mine";

export const DEFAULT_SORT: BookmarkSort = "recent";

/**
 * What the address of `/bookmarks` says about the list (doc 03 section 3.1). Every parameter is optional and only a
 * value that differs from the default is written, so the plain address is the plain list. The address has no page
 * number: the list loads further results with a button (keyset pagination, Q42).
 */
export interface BookmarkListSearch {
  /** Only pinned bookmarks. */
  pinned?: true;
  /** Only bookmarks with a slug. */
  hasSlug?: true;
  /** Only the bookmarks `/go` forwards to. */
  forwarding?: true;
  scope?: Exclude<BookmarkScope, "all">;
  sort?: BookmarkSort;
  view?: Exclude<BookmarkView, "grid">;
  size?: BookmarkPageSize;
}

function isTrue(value: unknown): boolean {
  // The router parses `true` into a boolean; a hand-written "true" is as good.
  return value === true || value === "true";
}

function isSort(value: unknown): value is BookmarkSort {
  return (BOOKMARK_SORTS as readonly unknown[]).includes(value);
}

function pageSizeOf(value: unknown): BookmarkPageSize | undefined {
  const size = typeof value === "string" ? Number(value) : value;
  return BOOKMARK_PAGE_SIZES.find((candidate) => candidate === size);
}

/** Reads the list parameters out of an address's search; a value that is none of the allowed ones is dropped, never an error. */
export function validateBookmarkListSearch(search: Record<string, unknown>): BookmarkListSearch {
  const result: BookmarkListSearch = {};
  if (isTrue(search.pinned)) {
    result.pinned = true;
  }
  if (isTrue(search.hasSlug)) {
    result.hasSlug = true;
  }
  if (isTrue(search.forwarding)) {
    result.forwarding = true;
  }
  if (search.scope === "mine") {
    result.scope = "mine";
  }
  if (isSort(search.sort) && search.sort !== DEFAULT_SORT) {
    result.sort = search.sort;
  }
  if (search.view === "table") {
    result.view = "table";
  }
  const size = pageSizeOf(search.size);
  if (size !== undefined) {
    result.size = size;
  }
  return result;
}

/**
 * The list parameters of the current address, read again through the validation. The router lays the validated
 * parameters over the raw ones and keeps a raw value the validation dropped, so the page reads the validated ones
 * from here rather than from the router's search.
 */
export function useBookmarkListSearch(): BookmarkListSearch {
  return validateBookmarkListSearch(useSearch({ from: "/_app/bookmarks" }));
}

/** The size of a load when the address names none: the grid loads 24, the table 48 (doc 02 section 5.7). */
export function pageSizeOfSearch(search: BookmarkListSearch): BookmarkPageSize {
  return search.size ?? (search.view === "table" ? 48 : 24);
}

/** Whether any filter narrows the list; the sort, the view and the size do not. */
export function hasActiveFilters(search: BookmarkListSearch): boolean {
  return search.pinned === true || search.hasSlug === true || search.forwarding === true || search.scope !== undefined;
}

/** The filters, sort and size a request for the list carries; the cursor is added by the query. */
export interface BookmarkListParams {
  readonly pinned?: "true";
  readonly hasSlug?: "true";
  readonly forwarding?: "true";
  readonly scope?: "mine";
  readonly sort: BookmarkSort;
  readonly limit: BookmarkPageSize;
}

export function listParamsOf(search: BookmarkListSearch): BookmarkListParams {
  return {
    ...(search.pinned === true ? { pinned: "true" as const } : {}),
    ...(search.hasSlug === true ? { hasSlug: "true" as const } : {}),
    ...(search.forwarding === true ? { forwarding: "true" as const } : {}),
    ...(search.scope === undefined ? {} : { scope: search.scope }),
    sort: search.sort ?? DEFAULT_SORT,
    limit: pageSizeOfSearch(search),
  };
}

export interface BookmarkListControls {
  /** Changes parameters of the list, as a navigation: back returns to the list as it was. A key set to `undefined` is removed. */
  readonly update: (changes: { readonly [Key in keyof BookmarkListSearch]: BookmarkListSearch[Key] | undefined }) => void;
  /** Removes every filter and keeps the sort, the view and the size. */
  readonly clearFilters: () => void;
}

/** The ways to change the list's parameters from the page. Whatever else the address holds (the bookmark modal's parameters) stays. */
export function useBookmarkListControls(): BookmarkListControls {
  const navigate = useNavigate();
  function go(change: (previous: Record<string, unknown>) => Record<string, unknown>): void {
    void navigate({ to: ".", search: (previous) => change(previous) });
  }
  return {
    update: (changes) => {
      go((previous) => {
        const next: Record<string, unknown> = { ...previous, ...changes };
        const entries: [string, unknown][] = Object.entries(changes);
        for (const [key, value] of entries) {
          if (value === undefined) {
            Reflect.deleteProperty(next, key);
          }
        }
        return next;
      });
    },
    clearFilters: () => {
      go((previous) => {
        const next = { ...previous };
        for (const key of ["pinned", "hasSlug", "forwarding", "scope"]) {
          Reflect.deleteProperty(next, key);
        }
        return next;
      });
    },
  };
}
