import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { membersOf, membersQuery, useActiveWorkspaceId, type Member } from "./workspace-members.ts";

export interface AllMembersOptions {
  /** Whether to load the list at all; a caller that needs it only for some viewers leaves it off for the rest. */
  readonly enabled?: boolean;
}

export interface AllMembers {
  /** The members loaded so far. */
  readonly members: readonly Member[];
  /** Whether every page is in, so the list is the whole workspace. */
  readonly complete: boolean;
  /** Whether loading the list failed; what is in `members` is then partial. */
  readonly failed: boolean;
  readonly retry: () => void;
}

/**
 * Every member of the workspace, loaded page after page. A choice that needs the whole workspace (who can receive
 * a departing member's content, whether another owner exists) reads it from here and waits for `complete`. After a
 * switch the cache holds the previous workspace's pages until the new ones are read; none of them is a member of this
 * list, and the list is not complete meanwhile.
 */
export function useAllMembers({ enabled = true }: AllMembersOptions = {}): AllMembers {
  const router = useRouter();
  const query = useInfiniteQuery({ ...membersQuery(router.options.context.api), enabled });
  const { hasNextPage, isFetching, isError, fetchNextPage, refetch } = query;
  const loadedPages = query.data?.pages.length ?? 0;
  // A page that answers in the render that follows the request leaves the other dependencies as they were, so the count of pages is one.
  useEffect(() => {
    if (enabled && hasNextPage && !isFetching && !isError) {
      void fetchNextPage();
    }
  }, [enabled, hasNextPage, isFetching, isError, fetchNextPage, loadedPages]);
  const workspaceId = useActiveWorkspaceId();
  const pages = workspaceId === undefined ? undefined : membersOf(query.data, workspaceId);
  return {
    members: pages?.flatMap((page) => page.items) ?? [],
    complete: pages !== undefined && query.isSuccess && !hasNextPage,
    failed: isError,
    retry: () => {
      void refetch();
    },
  };
}
