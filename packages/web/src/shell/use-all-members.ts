import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { membersQuery, type Member } from "./workspace-members.ts";

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
 * a departing member's content, whether another owner exists) reads it from here and waits for `complete`.
 */
export function useAllMembers(): AllMembers {
  const router = useRouter();
  const query = useInfiniteQuery(membersQuery(router.options.context.api));
  const { hasNextPage, isFetching, isError, fetchNextPage, refetch } = query;
  useEffect(() => {
    if (hasNextPage && !isFetching && !isError) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetching, isError, fetchNextPage]);
  return {
    members: query.data?.pages.flatMap((page) => page.items) ?? [],
    complete: query.isSuccess && !hasNextPage,
    failed: isError,
    retry: () => {
      void refetch();
    },
  };
}
