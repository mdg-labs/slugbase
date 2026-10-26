import { TAG_LIST_MAX_LIMIT, TAG_SORTS, type ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import { BOOKMARKS_QUERY_KEY, BOOKMARK_LISTS_QUERY_KEY, type BookmarkPage } from "../bookmarks/bookmarks.ts";

export { TAG_NAME_MAX_LENGTH, TAG_SORTS } from "@slugbase/contracts";

export type Tag = ComponentTypes["schemas"]["Tag"];
export type TagPage = ComponentTypes["schemas"]["TagList"];

export const TAGS_QUERY_KEY = ["tags"] as const;

/** One page of the caller's tags by name, from the cursor the page before it answered (none for the first). */
async function readTagPage(api: ApiClient, cursor: string | undefined, signal?: AbortSignal): Promise<TagPage> {
  const { data, error } = await api.GET("/api/v1/tags", {
    params: { query: { sort: "name", limit: TAG_LIST_MAX_LIMIT, ...(cursor === undefined ? {} : { cursor }) } },
    ...(signal === undefined ? {} : { signal }),
  });
  if (data === undefined) {
    throw new Error("The tag list did not answer with a document", { cause: error });
  }
  return data;
}

/** The caller's tags by name, a page at a time; the next page is asked for with the cursor the last one answered. */
export function tagListQuery(api: ApiClient) {
  return infiniteQueryOptions({
    queryKey: [...TAGS_QUERY_KEY, "list", "name"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }): Promise<TagPage> => readTagPage(api, pageParam, signal),
    getNextPageParam: (last): string | undefined => last.nextCursor ?? undefined,
  });
}

/** Every tag of the caller, read from the API now rather than from a cache; rejects when any page cannot be read. */
export async function readAllTags(api: ApiClient): Promise<Tag[]> {
  const tags: Tag[] = [];
  let cursor: string | undefined;
  do {
    const page = await readTagPage(api, cursor);
    tags.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return tags;
}

/**
 * The tag other than `own` that holds `name`, as the API decides it: names are unique per member without regard to case,
 * after the whitespace around them is removed (doc 04 section 10.7).
 */
export function tagNamed(tags: readonly Tag[], name: string, own: string): Tag | undefined {
  const wanted = name.trim().toLowerCase();
  return tags.find((tag) => tag.id !== own && tag.name.trim().toLowerCase() === wanted);
}

/** The orders the page offers, from the API's `sort` parameter (doc 02 section 7.2). */
export type TagSort = (typeof TAG_SORTS)[number];

export const DEFAULT_TAG_SORT: TagSort = "name";

function byName(a: Tag, b: Tag): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/** The tags whose name holds `query` (without regard to case), in the order `sort`: by name, or the most used first and then by name. */
export function visibleTags(tags: readonly Tag[], query: string, sort: TagSort): Tag[] {
  const needle = query.trim().toLowerCase();
  const matching = needle === "" ? [...tags] : tags.filter((tag) => tag.name.toLowerCase().includes(needle));
  return matching.sort(sort === "count" ? (a, b) => b.bookmarkCount - a.bookmarkCount || byName(a, b) : byName);
}

/** How many of a tag's newest bookmarks the page previews. */
export const TAG_PREVIEW_SIZE = 5;

/** The newest bookmarks that carry the tag, for the preview. It is under the bookmark lists, so a change to a bookmark refreshes it. */
export function tagPreviewQuery(api: ApiClient, tagId: string) {
  return queryOptions({
    queryKey: [...BOOKMARK_LISTS_QUERY_KEY, "tag-preview", tagId],
    queryFn: async ({ signal }): Promise<BookmarkPage> => {
      const { data, error } = await api.GET("/api/v1/bookmarks", {
        params: { query: { tag: [tagId], sort: "recent", limit: TAG_PREVIEW_SIZE } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The bookmarks of the tag did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}

export async function renameTag(api: ApiClient, id: string, name: string): Promise<Tag> {
  const { data, error } = await api.PATCH("/api/v1/tags/{id}", { params: { path: { id } }, body: { name } });
  if (data === undefined) {
    throw new Error("The tag rename did not answer with a document", { cause: error });
  }
  return data;
}

/** Moves the links of the tag `id` to the tag `intoTagId` and deletes it; the answer is the target with its new count. */
export async function mergeTag(api: ApiClient, id: string, intoTagId: string): Promise<Tag> {
  const { data, error } = await api.POST("/api/v1/tags/{id}/merge", { params: { path: { id } }, body: { intoTagId } });
  if (data === undefined) {
    throw new Error("The tag merge did not answer with a document", { cause: error });
  }
  return data;
}

export async function deleteTag(api: ApiClient, id: string): Promise<void> {
  const { response, error } = await api.DELETE("/api/v1/tags/{id}", { params: { path: { id } } });
  if (!response.ok) {
    throw new Error("The tag deletion did not answer with a problem document", { cause: error });
  }
}

/** Why a rename, merge or delete did not go through, as far as the member is told. */
export type TagFailure =
  | { readonly kind: "nameTaken" | "invalidName" | "notFound" | "unavailable" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined };

/** The failure to show for an error; undefined for an ended session, which the app answers as a whole. */
export function tagFailureOf(error: unknown): TagFailure | undefined {
  if (isSessionEnded(error)) {
    return undefined;
  }
  if (error instanceof ApiProblemError) {
    switch (error.status) {
      case 429:
        return { kind: "rateLimited", seconds: error.retryAfterSeconds };
      case 409:
        return { kind: "nameTaken" };
      case 404:
        return { kind: "notFound" };
      case 422:
        return { kind: "invalidName" };
    }
  }
  return { kind: "unavailable" };
}

/**
 * Reads again everything that shows tags after a rename, merge or delete changed them: the tag lists (the page, the tags
 * filter and the modal's choices) and the bookmarks, whose cards, rows and previews carry their tags.
 */
export function refreshTagViews(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: TAGS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: BOOKMARKS_QUERY_KEY });
}
