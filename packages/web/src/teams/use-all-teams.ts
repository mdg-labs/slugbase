import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { teamListQuery, type Team } from "./teams.ts";

export interface AllTeams {
  /** The teams read so far; all of them once `status` is "ready". */
  readonly teams: readonly Team[];
  /** "loading" until the whole list is read, "failed" when a page could not be, which no team is concluded from. */
  readonly status: "loading" | "ready" | "failed";
}

/** The workspace's teams, read page by page to the end, for a choice among all of them. */
export function useAllTeams(): AllTeams {
  const list = useInfiniteQuery(teamListQuery(useRouter().options.context.api));
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = list;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) {
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  const teams = list.data?.pages.flatMap((page) => page.items) ?? [];
  let status: AllTeams["status"] = "loading";
  if (isError) {
    status = "failed";
  } else if (list.data !== undefined && !hasNextPage) {
    status = "ready";
  }
  return { teams, status };
}
