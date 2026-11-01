import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { membersOf, membersQuery, useActiveWorkspaceId, type Member } from "../shell/workspace-members.ts";

export interface AllMembers {
  /** The members read so far; all of them once `status` is "ready". */
  readonly members: readonly Member[];
  /** "loading" until the whole list is read, "failed" when a page could not be, which no member is concluded from. */
  readonly status: "loading" | "ready" | "failed";
}

/** The workspace's members, read page by page to the end, for a choice among all of them. */
export function useAllMembers(): AllMembers {
  const list = useInfiniteQuery(membersQuery(useRouter().options.context.api));
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = list;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) {
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  // What the cache holds may be the previous workspace's list, which is read again after a switch and meanwhile no choice is made from.
  const workspaceId = useActiveWorkspaceId();
  const pages = workspaceId === undefined ? undefined : membersOf(list.data, workspaceId);
  const members = pages?.flatMap((page) => page.items) ?? [];
  let status: AllMembers["status"] = "loading";
  if (isError) {
    status = "failed";
  } else if (pages !== undefined && !hasNextPage) {
    status = "ready";
  }
  return { members, status };
}
