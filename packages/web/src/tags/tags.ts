import { TAG_LIST_MAX_LIMIT, type ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";

export { TAG_NAME_MAX_LENGTH } from "@slugbase/contracts";

export type Tag = ComponentTypes["schemas"]["Tag"];
export type TagPage = ComponentTypes["schemas"]["TagList"];

export const TAGS_QUERY_KEY = ["tags"] as const;

/** The caller's tags by name, a page at a time; the next page is asked for with the cursor the last one answered. */
export function tagListQuery(api: ApiClient) {
  return infiniteQueryOptions({
    queryKey: [...TAGS_QUERY_KEY, "list", "name"],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }): Promise<TagPage> => {
      const { data, error } = await api.GET("/api/v1/tags", {
        params: { query: { sort: "name", limit: TAG_LIST_MAX_LIMIT, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The tag list did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last): string | undefined => last.nextCursor ?? undefined,
  });
}
