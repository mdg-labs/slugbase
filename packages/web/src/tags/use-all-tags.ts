import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { TAGS_QUERY_KEY, tagListQuery, type Tag } from "./tags.ts";

export interface AllTags {
  /** The tags read so far; all of them once `status` is "ready". */
  readonly tags: readonly Tag[];
  /** "loading" until the whole list is read, "failed" when a page could not be, which no tag is concluded from. */
  readonly status: "loading" | "ready" | "failed";
  readonly retrying: boolean;
  readonly retry: () => void;
}

/** The member's tags by name, read page by page to the end; a list that could not be read is reported as such, never as no tags. */
export function useAllTags(): AllTags {
  const router = useRouter();
  // Its own entry in the cache, so a page that loads tags a page at a time is not given the whole list.
  const list = useInfiniteQuery({ ...tagListQuery(router.options.context.api), queryKey: [...TAGS_QUERY_KEY, "all"] });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = list;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) {
      // Another reader of the same list may be fetching this page already; asking again must not cancel and repeat it.
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  const tags = list.data?.pages.flatMap((page) => page.items) ?? [];
  let status: AllTags["status"] = "loading";
  if (isError) {
    status = "failed";
  } else if (list.data !== undefined && !hasNextPage) {
    status = "ready";
  }
  return {
    tags,
    status,
    retrying: list.isFetching,
    retry: () => {
      void list.refetch();
    },
  };
}
