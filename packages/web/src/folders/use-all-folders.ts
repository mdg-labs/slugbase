import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { DEFAULT_FOLDER_SORT, FOLDERS_QUERY_KEY, folderListQuery, type Folder } from "./folders.ts";

export interface AllFolders {
  /** The folders read so far; all of them once `status` is "ready". */
  readonly folders: readonly Folder[];
  /** "loading" until the whole list is read, "failed" when a page could not be, which no folder is concluded from. */
  readonly status: "loading" | "ready" | "failed";
  readonly retrying: boolean;
  readonly retry: () => void;
  /** Reads the whole list again; settles once the read has ended, whether it was answered or failed. */
  readonly reread: () => Promise<unknown>;
}

/**
 * The member's folders by name, read page by page to the end, for the places that show every folder or look one up by
 * its identifier (the sidebar, the folder filter). A list that could not be read is reported as such, so a caller never
 * takes it for a member with no folders.
 */
export function useAllFolders(): AllFolders {
  const router = useRouter();
  // Its own entry in the cache: the Folders page loads its list a page at a time, and this one is read to the end.
  const list = useInfiniteQuery({ ...folderListQuery(router.options.context.api, DEFAULT_FOLDER_SORT), queryKey: [...FOLDERS_QUERY_KEY, "all"] });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage, refetch } = list;
  const reread = useCallback(() => refetch(), [refetch]);
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) {
      // Another reader of the same list may be fetching this page already; asking again must not cancel and repeat it.
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  // The sidebar is on every page, so an answer that is no folder list is a list that failed, not a crash of the shell.
  const wellFormed = list.data?.pages.every((page) => Array.isArray(page.items)) ?? true;
  const folders = wellFormed ? (list.data?.pages.flatMap((page) => page.items) ?? []) : [];
  let status: AllFolders["status"] = "loading";
  if (isError || !wellFormed) {
    status = "failed";
  } else if (list.data !== undefined && !hasNextPage) {
    status = "ready";
  }
  return {
    folders,
    status,
    retrying: list.isFetching,
    retry: () => {
      void list.refetch();
    },
    reread,
  };
}
