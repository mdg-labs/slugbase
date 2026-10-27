import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";
import { BOOKMARK_LISTS_QUERY_KEY, type Bookmark } from "../bookmarks/bookmarks.ts";

/** How many bookmarks the palette lists under Recent. */
export const PALETTE_RECENT_LIMIT = 5;

/** How many it lists under Pinned. */
export const PALETTE_PINNED_LIMIT = 8;

/**
 * The bookmarks the palette lists before anything is typed (doc 02 section 9.2): the most recently opened ones (a bookmark that
 * was never opened is no recent one), and the pinned ones, newest first. Their keys sit under the bookmark lists', so a change to a bookmark
 * refreshes them with the lists.
 */
export function paletteBookmarksQuery(api: ApiClient, kind: "recent" | "pinned") {
  return queryOptions({
    queryKey: [...BOOKMARK_LISTS_QUERY_KEY, "palette", kind],
    queryFn: async ({ signal }): Promise<readonly Bookmark[]> => {
      const query =
        kind === "recent"
          ? { sort: "recently_opened" as const, limit: PALETTE_RECENT_LIMIT }
          : { sort: "recent" as const, limit: PALETTE_PINNED_LIMIT, pinned: "true" as const };
      const { data, error } = await api.GET("/api/v1/bookmarks", { params: { query }, signal });
      if (data === undefined) {
        throw new Error("The palette's bookmark list did not answer with a document", { cause: error });
      }
      return kind === "recent" ? data.items.filter((bookmark) => bookmark.lastOpenedAt !== null) : data.items;
    },
    staleTime: 0,
  });
}
