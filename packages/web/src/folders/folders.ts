import { FOLDER_LIST_DEFAULT_LIMIT, FOLDER_SORTS, type ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";

export {
  FOLDER_COLOR_MAX,
  FOLDER_COLOR_MIN,
  FOLDER_DEFAULT_COLOR,
  FOLDER_DEFAULT_ICON,
  FOLDER_ICONS,
  FOLDER_NAME_MAX_LENGTH,
  FOLDER_SORTS,
} from "@slugbase/contracts";

export type Folder = ComponentTypes["schemas"]["Folder"];
export type FolderPage = ComponentTypes["schemas"]["FolderList"];
export type CreateFolderRequest = ComponentTypes["schemas"]["CreateFolderRequest"];
export type UpdateFolderRequest = ComponentTypes["schemas"]["UpdateFolderRequest"];

/** The orders the list offers, from the API's `sort` parameter (doc 02 section 7.1). */
export type FolderSort = (typeof FOLDER_SORTS)[number];

export const DEFAULT_FOLDER_SORT: FolderSort = "name";

/** Whose folders a list holds: the member's own, or those other members shared with them (doc 03 section 6). The address leaves `mine` out, since it is the plain list. */
export const FOLDER_LIST_SCOPES = ["mine", "shared"] as const;

export type FolderListScope = (typeof FOLDER_LIST_SCOPES)[number];

export const DEFAULT_FOLDER_SCOPE: FolderListScope = "mine";

export const FOLDERS_QUERY_KEY = ["folders"] as const;

/**
 * The folders of `scope` in the order `sort`, a page at a time: the caller's own, or those shared with them. The next page is
 * asked for with the cursor the last one answered, which is valid only with the scope and the sort it was issued for, so both
 * are part of the key.
 */
export function folderListQuery(api: ApiClient, sort: FolderSort, scope: FolderListScope) {
  return infiniteQueryOptions({
    queryKey: [...FOLDERS_QUERY_KEY, "list", scope, sort],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }): Promise<FolderPage> => {
      const { data, error } = await api.GET("/api/v1/folders", {
        params: { query: { scope, sort, limit: FOLDER_LIST_DEFAULT_LIMIT, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The folder list did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last): string | undefined => last.nextCursor ?? undefined,
  });
}

export async function createFolder(api: ApiClient, body: CreateFolderRequest): Promise<Folder> {
  const { data, error } = await api.POST("/api/v1/folders", { body });
  if (data === undefined) {
    throw new Error("The folder creation did not answer with a document", { cause: error });
  }
  return data;
}

/** Changes a folder only if it is still at `version` (doc 04 section 2.4): the entity tag is the quoted version. */
export async function updateFolder(api: ApiClient, id: string, version: number, body: UpdateFolderRequest): Promise<Folder> {
  const { data, error } = await api.PATCH("/api/v1/folders/{id}", {
    params: { path: { id }, header: { "If-Match": `"${String(version)}"` } },
    body,
  });
  if (data === undefined) {
    throw new Error("The folder update did not answer with a document", { cause: error });
  }
  return data;
}

export async function deleteFolder(api: ApiClient, id: string): Promise<void> {
  const { response, error } = await api.DELETE("/api/v1/folders/{id}", { params: { path: { id } } });
  if (!response.ok) {
    throw new Error("The folder deletion did not answer with a problem document", { cause: error });
  }
}

/** Why a save or a delete did not go through, as far as the member is told. */
export type FolderFailure =
  | { readonly kind: "nameTaken" | "invalidName" | "changedElsewhere" | "notFound" | "unavailable" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined };

/** The failure to show for an error; undefined for an ended session, which the app answers as a whole. */
export function folderFailureOf(error: unknown): FolderFailure | undefined {
  if (isSessionEnded(error)) {
    return undefined;
  }
  if (error instanceof ApiProblemError) {
    switch (error.status) {
      case 429:
        return { kind: "rateLimited", seconds: error.retryAfterSeconds };
      case 409:
        return { kind: "nameTaken" };
      case 412:
        return { kind: "changedElsewhere" };
      case 404:
        return { kind: "notFound" };
      case 422:
        return { kind: "invalidName" };
    }
  }
  return { kind: "unavailable" };
}
