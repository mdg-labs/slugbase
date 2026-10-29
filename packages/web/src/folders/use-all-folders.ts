import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { meQuery } from "../account/me.ts";
import { entitlementsQuery, isGranted } from "../entitlements/index.ts";
import { DEFAULT_FOLDER_SORT, FOLDERS_QUERY_KEY, folderListQuery, type Folder, type FolderListScope } from "./folders.ts";

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
 * The whole list of `scope` by name, read page by page to the end. Nothing is read unless `reading` is "read": "skip" makes
 * the list ready and empty, for a list there is nothing to show of, and "wait" leaves it loading until it is known whether it is read.
 */
function useWholeFolderList(scope: FolderListScope, reading: "read" | "skip" | "wait"): AllFolders {
  const enabled = reading === "read";
  const router = useRouter();
  // Its own entry in the cache: the Folders page loads its list a page at a time, and this one is read to the end.
  const list = useInfiniteQuery({ ...folderListQuery(router.options.context.api, DEFAULT_FOLDER_SORT, scope), queryKey: [...FOLDERS_QUERY_KEY, "all", scope], enabled });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage, refetch } = list;
  const reread = useCallback(() => (enabled ? refetch() : Promise.resolve()), [enabled, refetch]);
  useEffect(() => {
    if (enabled && hasNextPage && !isFetchingNextPage && !isError) {
      // Another reader of the same list may be fetching this page already; asking again must not cancel and repeat it.
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [enabled, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  // The sidebar is on every page, so an answer that is no folder list is a list that failed, not a crash of the shell.
  const wellFormed = list.data?.pages.every((page) => Array.isArray(page.items)) ?? true;
  const folders = wellFormed ? (list.data?.pages.flatMap((page) => page.items) ?? []) : [];
  let status: AllFolders["status"] = "loading";
  if (reading === "skip") {
    status = "ready";
  } else if (isError || !wellFormed) {
    status = "failed";
  } else if (list.data !== undefined && !hasNextPage) {
    status = "ready";
  }
  return {
    folders: enabled ? folders : [],
    status,
    retrying: list.isFetching,
    retry: () => {
      void list.refetch();
    },
    reread,
  };
}

/**
 * The member's own folders by name, read page by page to the end, for the places that show every folder or look one up by
 * its identifier (the sidebar, the folder filter) and that file into one. A list that could not be read is reported as such, so a
 * caller never takes it for a member with no folders. Folders shared with the member are not in it (`useSharedFolders`).
 */
export function useAllFolders(): AllFolders {
  return useWholeFolderList("mine", "read");
}

/**
 * The folders other members shared with the member, by name, read to the end, for the sidebar and the folder filter. A workspace
 * that may not share holds none to show, so nothing is read once its entitlements say so; until they are in the list is loading,
 * and entitlements that could not be had grant the read, as the gates of the app do.
 */
export function useSharedFolders(): AllFolders {
  const api = useRouter().options.context.api;
  const me = useQuery({ ...meQuery(api), staleTime: Number.POSITIVE_INFINITY });
  const workspaceId = me.data?.activeWorkspaceId ?? undefined;
  const entitlements = useQuery({ ...entitlementsQuery(api, workspaceId ?? ""), enabled: workspaceId !== undefined });
  const mayShare = isGranted(entitlements.data, "sharing.members") || isGranted(entitlements.data, "sharing.teams");
  let reading: "read" | "skip" | "wait" = "read";
  if (workspaceId === undefined || entitlements.isPending) {
    reading = "wait";
  } else if (!mayShare) {
    reading = "skip";
  }
  return useWholeFolderList("shared", reading);
}
