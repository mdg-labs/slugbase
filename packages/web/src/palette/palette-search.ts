import { SEARCH_QUERY_MAX_LENGTH, type ComponentTypes } from "@slugbase/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";
import { BOOKMARK_LISTS_QUERY_KEY } from "../bookmarks/bookmarks.ts";
import { PALETTE_SEARCH_DELAY_MS, useDebouncedValue } from "./palette-query.ts";

export type SearchResults = ComponentTypes["schemas"]["SearchResults"];
export type SearchBookmark = ComponentTypes["schemas"]["SearchBookmark"];

const NO_RESULTS: SearchResults = { bookmarks: [], folders: [], tags: [] };

/**
 * One search of the member's bookmarks, folders and tags (doc 02 section 9.1). The key sits under the bookmark lists', so a change
 * to a bookmark refreshes it with them. Leaving the key, as the query changes, cancels the request in flight.
 */
export function paletteSearchQuery(api: ApiClient, text: string) {
  return queryOptions({
    queryKey: [...BOOKMARK_LISTS_QUERY_KEY, "palette", "search", text],
    queryFn: async ({ signal }): Promise<SearchResults> => {
      const { data, error } = await api.GET("/api/v1/search", { params: { query: { q: text } }, signal });
      if (data === undefined) {
        throw new Error("The palette's search did not answer with a document", { cause: error });
      }
      return data;
    },
    staleTime: 0,
    // The error row of the palette retries when it is chosen.
    retry: false,
  });
}

export type PaletteSearch =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly retry: () => void }
  | { readonly status: "ready"; readonly results: SearchResults };

/**
 * The results for `text` once it has stayed unchanged for 150 ms. Until then, and while the request runs, the search is loading: results
 * of an earlier text are never shown for a later one, so an answer that arrives late is dropped with its request.
 */
export function usePaletteSearch(api: ApiClient, text: string | undefined): PaletteSearch {
  const settled = useDebouncedValue(text, PALETTE_SEARCH_DELAY_MS);
  // The API refuses a query over its length; such a query is no title, host or slug, so it matches nothing without asking.
  const tooLong = settled !== undefined && settled.length > SEARCH_QUERY_MAX_LENGTH;
  const query = useQuery({ ...paletteSearchQuery(api, settled ?? ""), enabled: settled !== undefined && !tooLong });
  if (text === undefined || text !== settled) {
    return { status: "loading" };
  }
  if (tooLong) {
    return { status: "ready", results: NO_RESULTS };
  }
  if (query.data !== undefined) {
    return { status: "ready", results: query.data };
  }
  return query.isError ? { status: "error", retry: () => void query.refetch() } : { status: "loading" };
}
