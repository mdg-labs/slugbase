import type { ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client.ts";

export type FormerBookmark = ComponentTypes["schemas"]["FormerBookmark"];
export type FormerFolder = ComponentTypes["schemas"]["FormerFolder"];

export const FORMER_CONTENT_QUERY_KEY = ["former-content"] as const;

const PAGE_SIZE = 50;

/** The key of one of the lists of the workspace; it sits under `FORMER_CONTENT_QUERY_KEY`, so invalidating that key reaches both. */
function listKey(workspaceId: string, list: "bookmarks" | "folders") {
  return [...FORMER_CONTENT_QUERY_KEY, workspaceId, list] as const;
}

/**
 * The bookmarks with no owner of the workspace the session acts in (doc 02 section 2.10), a page at a time, kept under that workspace's key because the
 * request names no workspace and a list kept under one key would stand in the workspace the session has moved to.
 */
export function formerBookmarksQuery(api: ApiClient, workspaceId: string) {
  return infiniteQueryOptions({
    queryKey: listKey(workspaceId, "bookmarks"),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await api.GET("/api/v1/workspace/former-content/bookmarks", {
        params: { query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The former members' bookmarks request did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** The folders with no owner of the workspace the session acts in, a page at a time, kept under that workspace's key. */
export function formerFoldersQuery(api: ApiClient, workspaceId: string) {
  return infiniteQueryOptions({
    queryKey: listKey(workspaceId, "folders"),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await api.GET("/api/v1/workspace/former-content/folders", {
        params: { query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The former members' folders request did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
