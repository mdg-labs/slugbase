import type { ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";

export type Session = ComponentTypes["schemas"]["Session"];

export const SESSIONS_QUERY_KEY = ["account", "sessions"] as const;

const PAGE_SIZE = 50;

/** The account's valid sessions, newest first, a page at a time. */
export function sessionsQuery(api: ApiClient) {
  return infiniteQueryOptions({
    queryKey: SESSIONS_QUERY_KEY,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await api.GET("/api/v1/me/sessions", {
        params: { query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
      });
      if (data === undefined) {
        throw new Error("The sessions request did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
