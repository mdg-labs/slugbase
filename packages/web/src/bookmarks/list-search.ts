import { BOOKMARK_SCOPES, SEARCH_QUERY_MAX_LENGTH } from "@slugbase/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import { useCachedAccount } from "../account/use-cached-account.ts";

/** The orders the list offers, from the API's `sort` parameter (doc 02 section 5.7). */
export const BOOKMARK_SORTS = ["recent", "oldest", "title_asc", "title_desc", "most_used", "recently_opened"] as const;

export type BookmarkSort = (typeof BOOKMARK_SORTS)[number];

/** How many bookmarks each load adds (doc 02 section 5.7); the choice is the `limit` of the request. */
export const BOOKMARK_PAGE_SIZES = [24, 48, 96] as const;

export type BookmarkPageSize = (typeof BOOKMARK_PAGE_SIZES)[number];

export type BookmarkView = "grid" | "table";

/** Whose bookmarks the list holds (doc 02 section 5.7); the address leaves `all` out, since it is the plain list. */
export type BookmarkScope = (typeof BOOKMARK_SCOPES)[number];

export const DEFAULT_SORT: BookmarkSort = "recent";

/** How many tags a request may name (doc 04, the `tag` parameter of the list). */
export const BOOKMARK_TAG_FILTER_MAX = 10;

// The identifiers the API accepts: versions 1 to 8, or the nil and max values. Anything else would be refused with 422.
const IDENTIFIER = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

/**
 * What the address of `/bookmarks` says about the list (doc 03 section 3.1). Every parameter is optional and a filter,
 * sort or size is only written when it differs from the default, so the plain address is the plain list. The view is
 * written once it is chosen, so a link opens the view it was copied from whatever the account's default is. The address has no page
 * number: the list loads further results with a button (keyset pagination, Q42).
 */
export interface BookmarkListSearch {
  /** Only pinned bookmarks. */
  pinned?: true;
  /** Only bookmarks with a slug. */
  hasSlug?: true;
  /** Only the bookmarks `/go` forwards to. */
  forwarding?: true;
  /** Only bookmarks filed in this folder. */
  folderId?: string;
  /** Only bookmarks the text matches (their title, host, slug and description), as typed in the search field. */
  q?: string;
  /** Only bookmarks that carry every one of these tags (AND), by identifier. */
  tag?: readonly string[];
  scope?: Exclude<BookmarkScope, "all">;
  sort?: BookmarkSort;
  /** How the list is shown; left out, the account's default view applies. */
  view?: BookmarkView;
  size?: BookmarkPageSize;
}

function isTrue(value: unknown): boolean {
  // The router parses `true` into a boolean; a hand-written "true" is as good.
  return value === true || value === "true";
}

function isSort(value: unknown): value is BookmarkSort {
  return (BOOKMARK_SORTS as readonly unknown[]).includes(value);
}

function isListedScope(value: unknown): value is Exclude<BookmarkScope, "all"> {
  return value !== "all" && (BOOKMARK_SCOPES as readonly unknown[]).includes(value);
}

function identifierOf(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}

function identifiersOf(value: unknown): readonly string[] {
  // One tag arrives as a bare string and several as a list; a value that is no identifier is dropped, a repeat counts once.
  const entries: readonly unknown[] = Array.isArray(value) ? (value as readonly unknown[]) : [value];
  const identifiers = entries.flatMap((entry) => identifierOf(entry) ?? []);
  return [...new Set(identifiers)].slice(0, BOOKMARK_TAG_FILTER_MAX);
}

/** The text of the address's `q`: the router reads a text that looks like a number or a boolean as one, which is the text again; blank text and a text over the API's longest are no filter. */
function queryOf(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  const trimmed = text.trim();
  return trimmed === "" || trimmed.length > SEARCH_QUERY_MAX_LENGTH ? undefined : trimmed;
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
  const folderId = identifierOf(search.folderId);
  if (folderId !== undefined) {
    result.folderId = folderId;
  }
  const q = queryOf(search.q);
  if (q !== undefined) {
    result.q = q;
  }
  const tag = identifiersOf(search.tag);
  if (tag.length > 0) {
    result.tag = tag;
  }
  if (isListedScope(search.scope)) {
    result.scope = search.scope;
  }
  if (isSort(search.sort) && search.sort !== DEFAULT_SORT) {
    result.sort = search.sort;
  }
  if (search.view === "table" || search.view === "grid") {
    result.view = search.view;
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
export function useBookmarkListSearch(): BookmarkListSearch & { readonly view: BookmarkView } {
  const search = validateBookmarkListSearch(useSearch({ from: "/_app/bookmarks" }));
  const defaultView = useCachedAccount()?.defaultView;
  // The address wins; without it the account's default view applies (doc 02 section 2.1), and the grid until the account is read.
  return { ...search, view: search.view ?? defaultView ?? "grid" };
}

/** The size of a load when the address names none: the grid loads 24, the table 48 (doc 02 section 5.7). */
export function pageSizeOfSearch(search: BookmarkListSearch): BookmarkPageSize {
  return search.size ?? (search.view === "table" ? 48 : 24);
}

/** Whether any filter narrows the list, the text of the search among them; the sort, the view and the size do not. */
export function hasActiveFilters(search: BookmarkListSearch): boolean {
  return (
    search.pinned === true ||
    search.hasSlug === true ||
    search.forwarding === true ||
    search.scope !== undefined ||
    search.folderId !== undefined ||
    search.q !== undefined ||
    (search.tag?.length ?? 0) > 0
  );
}

/** The parameters that choose which bookmarks the list holds, which "select all matching" names as well; the sort and the size only shape how they are laid out. */
export interface BookmarkFilterParams {
  readonly pinned?: "true";
  readonly hasSlug?: "true";
  readonly forwarding?: "true";
  readonly scope?: Exclude<BookmarkScope, "all">;
  readonly folderId?: string;
  readonly q?: string;
  readonly tag?: string[];
}

/** The search without its folder filter, for a folder the member does not have. */
export function withoutFolder(search: BookmarkListSearch): BookmarkListSearch {
  const rest = { ...search };
  Reflect.deleteProperty(rest, "folderId");
  return rest;
}

/** The filters, sort and size a request for the list carries; the cursor is added by the query. */
export interface BookmarkListParams extends BookmarkFilterParams {
  readonly sort: BookmarkSort;
  readonly limit: BookmarkPageSize;
}

/** Every filter that chooses which bookmarks the list holds, the folder and the tags included. */
export function filterParamsOf(search: BookmarkListSearch): BookmarkFilterParams {
  return {
    ...(search.pinned === true ? { pinned: "true" as const } : {}),
    ...(search.hasSlug === true ? { hasSlug: "true" as const } : {}),
    ...(search.forwarding === true ? { forwarding: "true" as const } : {}),
    ...(search.scope === undefined ? {} : { scope: search.scope }),
    ...(search.folderId === undefined ? {} : { folderId: search.folderId }),
    ...(search.q === undefined ? {} : { q: search.q }),
    ...(search.tag === undefined || search.tag.length === 0 ? {} : { tag: [...search.tag] }),
  };
}

export function listParamsOf(search: BookmarkListSearch): BookmarkListParams {
  return { ...filterParamsOf(search), sort: search.sort ?? DEFAULT_SORT, limit: pageSizeOfSearch(search) };
}

export interface BookmarkListControls {
  /** Changes parameters of the list, as a navigation: back returns to the list as it was. A key set to `undefined` is removed. */
  readonly update: (changes: { readonly [Key in keyof BookmarkListSearch]: BookmarkListSearch[Key] | undefined }, options?: { readonly replace?: boolean }) => void;
  /** Removes every filter and keeps the sort, the view and the size. */
  readonly clearFilters: () => void;
}

/** The ways to change the list's parameters from the page. Whatever else the address holds (the bookmark modal's parameters) stays. */
export function useBookmarkListControls(): BookmarkListControls {
  const navigate = useNavigate();
  return useMemo(() => {
    function go(change: (previous: Record<string, unknown>) => Record<string, unknown>, replace: boolean): void {
      void navigate({ to: ".", search: (previous) => change(previous), replace });
    }
    return {
      update: (changes, options) => {
        go((previous) => {
          const next: Record<string, unknown> = { ...previous, ...changes };
          const entries: [string, unknown][] = Object.entries(changes);
          for (const [key, value] of entries) {
            if (value === undefined) {
              Reflect.deleteProperty(next, key);
            }
          }
          return next;
        }, options?.replace === true);
      },
      clearFilters: () => {
        go((previous) => {
          const next = { ...previous };
          for (const key of ["pinned", "hasSlug", "forwarding", "scope", "folderId", "q", "tag"]) {
            Reflect.deleteProperty(next, key);
          }
          return next;
        }, false);
      },
    };
  }, [navigate]);
}
