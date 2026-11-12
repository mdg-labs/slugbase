import { FORMER_CONTENT_DELETE_MAX, type ComponentTypes } from "@slugbase/contracts";
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

/** What a deletion removed, in the units the server counts. */
export interface FormerContentDeleted {
  readonly bookmarksDeleted: number;
  readonly foldersDeleted: number;
}

/** The elements of `ids` from `start`, at most as many as one request takes. */
function sliceOf(ids: readonly string[], start: number): string[] {
  return ids.slice(start, start + FORMER_CONTENT_DELETE_MAX);
}

/**
 * Deletes the named former members' bookmarks and folders (doc 04 section 10.5), for good. A request takes at most `FORMER_CONTENT_DELETE_MAX` identifiers a list, so a
 * longer selection goes in several requests, one after the other, and the answers are added up. `onProgress` is told the total after each request that answered, so a
 * caller whose later request fails knows how much the earlier ones deleted. A failure throws the failure itself. The server skips an identifier that names no such row, so a
 * repeat of a request is harmless.
 */
export async function deleteFormerContent(
  api: ApiClient,
  request: { readonly bookmarkIds: readonly string[]; readonly folderIds: readonly string[] },
  onProgress: (deleted: FormerContentDeleted) => void = () => undefined,
): Promise<FormerContentDeleted> {
  const requests = Math.max(Math.ceil(request.bookmarkIds.length / FORMER_CONTENT_DELETE_MAX), Math.ceil(request.folderIds.length / FORMER_CONTENT_DELETE_MAX));
  let bookmarksDeleted = 0;
  let foldersDeleted = 0;
  for (let index = 0; index < requests; index += 1) {
    const bookmarkIds = sliceOf(request.bookmarkIds, index * FORMER_CONTENT_DELETE_MAX);
    const folderIds = sliceOf(request.folderIds, index * FORMER_CONTENT_DELETE_MAX);
    const { data, error } = await api.POST("/api/v1/workspace/former-content/delete", {
      body: { ...(bookmarkIds.length === 0 ? {} : { bookmarkIds }), ...(folderIds.length === 0 ? {} : { folderIds }) },
    });
    if (data === undefined) {
      throw new Error("The former members' content deletion did not answer with a document", { cause: error });
    }
    bookmarksDeleted += data.bookmarksDeleted;
    foldersDeleted += data.foldersDeleted;
    onProgress({ bookmarksDeleted, foldersDeleted });
  }
  return { bookmarksDeleted, foldersDeleted };
}
