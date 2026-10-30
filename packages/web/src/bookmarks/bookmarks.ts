import { BOOKMARK_BULK_IDS_MAX, BOOKMARK_SLUG_PATTERN, CreateBookmarkRequestSchema, UpdateBookmarkRequestSchema, type ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import type { BookmarkFilterParams, BookmarkListParams } from "./list-search.ts";

export { BOOKMARK_SELECT_ALL_CAP } from "@slugbase/contracts";

export type Bookmark = ComponentTypes["schemas"]["Bookmark"];
export type CreateBookmarkRequest = ComponentTypes["schemas"]["CreateBookmarkRequest"];
export type UpdateBookmarkRequest = ComponentTypes["schemas"]["UpdateBookmarkRequest"];

export type BookmarkPage = ComponentTypes["schemas"]["BookmarkList"];

export const BOOKMARKS_QUERY_KEY = ["bookmarks"] as const;

/** The key every loaded list of bookmarks is under, whatever its filters. */
export const BOOKMARK_LISTS_QUERY_KEY = [...BOOKMARKS_QUERY_KEY, "list"] as const;

export { BOOKMARK_DESCRIPTION_MAX_LENGTH, BOOKMARK_SLUG_MAX_LENGTH, BOOKMARK_TITLE_MAX_LENGTH, BOOKMARK_URL_MAX_LENGTH } from "@slugbase/contracts";

export type BookmarkMetadata = ComponentTypes["schemas"]["BookmarkMetadata"];

export type SlugAvailability =ComponentTypes["schemas"]["SlugAvailability"];

/** One bookmark of the caller, as the modal edits it. */
export function bookmarkQuery(api: ApiClient, id: string) {
  return queryOptions({
    queryKey: [...BOOKMARKS_QUERY_KEY, "detail", id],
    queryFn: async ({ signal }): Promise<Bookmark> => {
      const { data, error } = await api.GET("/api/v1/bookmarks/{id}", { params: { path: { id } }, signal });
      if (data === undefined) {
        throw new Error("The bookmark request did not answer with a document", { cause: error });
      }
      return data;
    },
  });
}

/**
 * The caller's bookmarks under `params`, a page at a time. The next page is asked for with the cursor the last one
 * answered (keyset pagination, doc 04 section 6.1); a cursor is valid only with the filters and sort it was issued for,
 * so the parameters are part of the key and a change of them starts a new list.
 */
export function bookmarkListQuery(api: ApiClient, params: BookmarkListParams) {
  return infiniteQueryOptions({
    queryKey: [...BOOKMARK_LISTS_QUERY_KEY, params],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }): Promise<BookmarkPage> => {
      const { data, error } = await api.GET("/api/v1/bookmarks", {
        params: { query: { ...params, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The bookmark list did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last): string | undefined => last.nextCursor ?? undefined,
  });
}

/** The caller's bookmarks whose canonical URL is the one of `url` (doc 02 section 5.2, the duplicate warning). */
export function bookmarksByUrlQuery(api: ApiClient, url: string | undefined) {
  return queryOptions({
    queryKey: [...BOOKMARKS_QUERY_KEY, "by-url", url],
    queryFn: async ({ signal }): Promise<readonly Bookmark[]> => {
      if (url === undefined) {
        return [];
      }
      const { data, error } = await api.GET("/api/v1/bookmarks", { params: { query: { url, limit: 2 } }, signal });
      if (data === undefined) {
        throw new Error("The bookmark lookup did not answer with a document", { cause: error });
      }
      return data.items;
    },
    enabled: url !== undefined,
    staleTime: 0,
    gcTime: 0,
  });
}

/**
 * The title and description of the page at `url` (doc 02 section 5.4). The prefill is a convenience: a refused address, an
 * upstream failure, a rate limit, a network error and an aborted request all answer nothing, and the fields stay as entered.
 */
export async function readPageMetadata(api: ApiClient, url: string, signal: AbortSignal): Promise<BookmarkMetadata | undefined> {
  try {
    const { data } = await api.POST("/api/v1/bookmarks/metadata", { body: { url }, signal });
    return data;
  } catch {
    return undefined;
  }
}

/**
 * Whether the caller can use `slug` in the workspace (doc 04 section 10.6). `bookmarkId` is the bookmark being changed, whose own
 * slug is then available; a new bookmark has none.
 */
export function slugAvailabilityQuery(api: ApiClient, slug: string | undefined, bookmarkId: string | undefined) {
  return queryOptions({
    queryKey: ["slugs", "availability", slug, bookmarkId],
    queryFn: async ({ signal }): Promise<SlugAvailability> => {
      if (slug === undefined) {
        throw new Error("There is no slug to check");
      }
      const { data, error } = await api.GET("/api/v1/slugs/availability", {
        params: { query: { slug, ...(bookmarkId === undefined ? {} : { bookmarkId }) } },
        signal,
      });
      if (data === undefined) {
        throw new Error("The slug check did not answer with a document", { cause: error });
      }
      return data;
    },
    enabled: slug !== undefined,
    staleTime: 0,
    gcTime: 0,
  });
}

/** Whether `slug`, as the member typed it, is one the API accepts: 1 to 64 lower-case letters, digits and hyphens, not starting with a hyphen. */
export function isValidSlug(slug: string): boolean {
  return BOOKMARK_SLUG_PATTERN.test(slug);
}

export async function createBookmark(api: ApiClient, body: CreateBookmarkRequest): Promise<Bookmark> {
  const { data, error } = await api.POST("/api/v1/bookmarks", { body });
  if (data === undefined) {
    throw new Error("The bookmark creation did not answer with a document", { cause: error });
  }
  return data;
}

/** Changes a bookmark only if it is still at `version` (doc 04 section 2.4): the entity tag is the quoted version. */
export async function updateBookmark(api: ApiClient, id: string, version: number, body: UpdateBookmarkRequest): Promise<Bookmark> {
  const { data, error } = await api.PATCH("/api/v1/bookmarks/{id}", {
    params: { path: { id }, header: { "If-Match": `"${String(version)}"` } },
    body,
  });
  if (data === undefined) {
    throw new Error("The bookmark update did not answer with a document", { cause: error });
  }
  return data;
}

/**
 * Counts an open of the bookmark (doc 04 section 4, `POST /bookmarks/{id}/open`). The page is on its way to the
 * destination when this is sent, so the request is kept alive past the navigation, and nothing waits for the answer.
 */
export function recordOpen(api: ApiClient, id: string): void {
  api.POST("/api/v1/bookmarks/{id}/open", { params: { path: { id } }, keepalive: true }).catch(() => {
    // The count is a statistic and the member has left the page: a failed request has nobody to tell and is not retried.
  });
}

export async function deleteBookmark(api: ApiClient, id: string): Promise<void> {
  const { response, error } = await api.DELETE("/api/v1/bookmarks/{id}", { params: { path: { id } } });
  if (!response.ok) {
    throw new Error("The bookmark deletion did not answer with a problem document", { cause: error });
  }
}

export type BulkAction = ComponentTypes["schemas"]["BulkBookmarksRequest"]["action"];

/** The member or team a share action shares with, as the share targets list them. */
export interface BulkShareTarget {
  readonly kind: "member" | "team";
  readonly id: string;
  readonly name: string;
}

/** The folder or the tags a folder or tag action acts with, as the list shows them on a bookmark, or the member or team a share acts with. */
export type BulkTarget = { readonly folder: BookmarkFolder } | { readonly tags: readonly BookmarkTag[] } | { readonly shareWith: BulkShareTarget };

export type BookmarkFolder = ComponentTypes["schemas"]["BookmarkFolder"];
export type BookmarkTag = ComponentTypes["schemas"]["BookmarkTag"];

/** What a bulk request did, as counts. */
export interface BulkTotals {
  readonly requested: number;
  readonly affected: number;
  readonly skipped: number;
}

/** The identifiers of the bookmarks that match the filters of `params` (the sort and size do not matter), and whether more match than the select-all cap. */
export async function listBookmarkIds(api: ApiClient, params: BookmarkFilterParams): Promise<ComponentTypes["schemas"]["BookmarkIds"]> {
  const { data, error } = await api.GET("/api/v1/bookmarks/ids", { params: { query: params } });
  if (data === undefined) {
    throw new Error("The bookmark identifiers did not answer with a document", { cause: error });
  }
  return data;
}

/**
 * A bulk request that stopped partway: `completed` is what the requests before the failed one did and `remaining` the
 * identifiers they did not reach, which the failed one included. Nothing of the failed request itself was changed.
 */
export class BulkPartialError extends Error {
  readonly completed: BulkTotals;
  readonly remaining: readonly string[];

  constructor(completed: BulkTotals, remaining: readonly string[], cause: unknown) {
    super("A bulk request on bookmarks stopped before it reached every bookmark", { cause });
    this.name = "BulkPartialError";
    this.completed = completed;
    this.remaining = remaining;
  }
}

function shareTargetBody(target: BulkShareTarget): { readonly accountId: string } | { readonly teamId: string } {
  return target.kind === "member" ? { accountId: target.id } : { teamId: target.id };
}

function targetBody(target: BulkTarget | undefined): { readonly folderId?: string; readonly tagIds?: string[]; readonly accountId?: string; readonly teamId?: string } {
  if (target === undefined) {
    return {};
  }
  if ("shareWith" in target) {
    return shareTargetBody(target.shareWith);
  }
  return "folder" in target ? { folderId: target.folder.id } : { tagIds: target.tags.map((tag) => tag.id) };
}

/**
 * Deletes, pins, unpins, files, tags or shares the bookmarks `ids` (doc 04 section 6.2); a folder or tag action names its folder or
 * tags in `target`, and a share the member or team. The API takes at most 1 000 identifiers in a request and each request is one transaction, so a longer
 * selection is sent in turns, one after the other, and stops at the first failure: a failure after the first turn raises a
 * `BulkPartialError` that says how far it got.
 */
export async function bulkBookmarks(api: ApiClient, action: BulkAction, ids: readonly string[], target?: BulkTarget): Promise<BulkTotals> {
  let totals: BulkTotals = { requested: 0, affected: 0, skipped: 0 };
  for (let start = 0; start < ids.length; start += BOOKMARK_BULK_IDS_MAX) {
    try {
      const { data, error } = await api.POST("/api/v1/bookmarks/bulk", {
        body: { action, ids: ids.slice(start, start + BOOKMARK_BULK_IDS_MAX), ...targetBody(target) },
      });
      if (data === undefined) {
        throw new Error("The bulk request did not answer with a document", { cause: error });
      }
      totals = { requested: totals.requested + data.requested, affected: totals.affected + data.affected, skipped: totals.skipped + data.skipped };
    } catch (error) {
      if (start === 0) {
        throw error;
      }
      throw new BulkPartialError(totals, ids.slice(start), error);
    }
  }
  return totals;
}

/** What adding tags to the selection would do: the counts of the request and, per tag, how many bookmarks carry it afterwards and how many get it. */
export interface TagPreview {
  readonly requested: number;
  readonly affected: number;
  readonly skipped: number;
  readonly tags: readonly { readonly id: string; readonly name: string; readonly bookmarkCount: number; readonly added: number }[];
}

/**
 * Asks what adding `tagIds` to the bookmarks `ids` would do, writing nothing (`POST /bookmarks/bulk/preview`). A longer
 * selection than one request takes is asked in turns, whose bookmarks are distinct, so the counts of the turns add up.
 */
export async function previewAddTags(api: ApiClient, ids: readonly string[], tagIds: readonly string[], signal?: AbortSignal): Promise<TagPreview> {
  let requested = 0;
  let affected = 0;
  let skipped = 0;
  const tags = new Map<string, { id: string; name: string; bookmarkCount: number; added: number }>();
  for (let start = 0; start < ids.length; start += BOOKMARK_BULK_IDS_MAX) {
    const { data, error } = await api.POST("/api/v1/bookmarks/bulk/preview", {
      body: { action: "add_tags", ids: ids.slice(start, start + BOOKMARK_BULK_IDS_MAX), tagIds: [...tagIds] },
      ...(signal === undefined ? {} : { signal }),
    });
    if (data === undefined) {
      throw new Error("The tag preview did not answer with a document", { cause: error });
    }
    requested += data.requested;
    affected += data.affected;
    skipped += data.skipped;
    for (const tag of data.tags) {
      const seen = tags.get(tag.id);
      tags.set(tag.id, seen === undefined ? { ...tag } : { ...seen, bookmarkCount: seen.bookmarkCount + tag.bookmarkCount, added: seen.added + tag.added });
    }
  }
  return { requested, affected, skipped, tags: [...tags.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** What sharing the selection would do: the counts of the request and who the bookmarks it reaches are shared with afterwards. */
export interface SharePreview {
  readonly requested: number;
  readonly affected: number;
  readonly skipped: number;
  /** The target, with how many members other than the caller read through it and how many of the bookmarks get a share from the action. */
  readonly audience: { readonly name: string; readonly memberCount: number; readonly added: number };
}

/**
 * Asks what sharing the bookmarks `ids` with `target` would do, writing nothing (`POST /bookmarks/bulk/preview`). A longer
 * selection than one request takes is asked in turns, whose bookmarks are distinct, so the counts of the turns add up.
 */
export async function previewShare(api: ApiClient, ids: readonly string[], target: BulkShareTarget, signal?: AbortSignal): Promise<SharePreview> {
  let requested = 0;
  let affected = 0;
  let skipped = 0;
  let added = 0;
  let audience: { readonly name: string; readonly memberCount: number } | undefined;
  for (let start = 0; start < ids.length; start += BOOKMARK_BULK_IDS_MAX) {
    const { data, error } = await api.POST("/api/v1/bookmarks/bulk/preview", {
      body: { action: "share", ids: ids.slice(start, start + BOOKMARK_BULK_IDS_MAX), ...shareTargetBody(target) },
      ...(signal === undefined ? {} : { signal }),
    });
    if (data === undefined || data.audience === null) {
      throw new Error("The share preview did not answer with an audience", { cause: error });
    }
    requested += data.requested;
    affected += data.affected;
    skipped += data.skipped;
    added += data.audience.added;
    audience = { name: data.audience.name, memberCount: data.audience.memberCount };
  }
  if (audience === undefined) {
    throw new Error("There is nothing to preview");
  }
  return { requested, affected, skipped, audience: { ...audience, added } };
}

export type FieldName = "url" | "title" | "description" | "slug" | "tagNames";

/** Why a field's value is refused. */
export type FieldProblem = "required" | "tooLong" | "notAllowed" | "invalid" | "taken";

export type FieldProblems = Partial<Record<FieldName, FieldProblem>>;

/** Why a save or a delete did not go through, as far as the member is told. */
export type BookmarkFailure =
  | { readonly kind: "limitReached" }
  | { readonly kind: "changedElsewhere" }
  | { readonly kind: "notFound" }
  | { readonly kind: "fields"; readonly problems: FieldProblems }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "unavailable" }
  | { readonly kind: "loadFailed" };

const FIELDS: readonly FieldName[] = ["url", "title", "description", "slug", "tagNames"];

function isFieldName(path: string): path is FieldName {
  return (FIELDS as readonly string[]).includes(path);
}

function problemOfCode(code: string): FieldProblem {
  switch (code) {
    case "too_small":
      return "required";
    case "too_big":
      return "tooLong";
    case "url_not_allowed":
      return "notAllowed";
    default:
      return "invalid";
  }
}

/** The problems of the fields a `422` names; a field it does not name is not in the result. */
export function fieldProblemsOf(errors: readonly { readonly path: string; readonly code: string }[]): FieldProblems {
  const problems: Partial<Record<FieldName, FieldProblem>> = {};
  for (const { path, code } of errors) {
    // A problem with one entry of a list names the entry after the field (`tagNames.0`).
    const field = path.split(".")[0] ?? path;
    if (isFieldName(field) && problems[field] === undefined) {
      problems[field] = problemOfCode(code);
    }
  }
  return problems;
}

/** The failure to show for an error; undefined for an ended session, which the app answers as a whole. */
export function bookmarkFailureOf(error: unknown): BookmarkFailure | undefined {
  if (isSessionEnded(error)) {
    return undefined;
  }
  if (error instanceof ApiProblemError) {
    if (error.status === 429) {
      return { kind: "rateLimited", seconds: error.retryAfterSeconds };
    }
    if (error.status === 412) {
      return { kind: "changedElsewhere" };
    }
    if (error.status === 404) {
      return { kind: "notFound" };
    }
    if (error.code === "bookmark_limit_reached") {
      return { kind: "limitReached" };
    }
    if (error.code === "url_not_allowed") {
      return { kind: "fields", problems: { url: "notAllowed" } };
    }
    if (error.code === "slug_taken") {
      return { kind: "fields", problems: { slug: "taken" } };
    }
    if (error.status === 422) {
      const problems = fieldProblemsOf(error.errors);
      if (Object.keys(problems).length > 0) {
        return { kind: "fields", problems };
      }
    }
  }
  return { kind: "unavailable" };
}

/** Whether the error says the bookmark asked for is not the caller's to read (no such bookmark, or an identifier that is none). */
export function isBookmarkMissing(error: unknown): boolean {
  return error instanceof ApiProblemError && (error.status === 404 || error.status === 422);
}

/**
 * Whether the bookmark is another member's and shared with the caller (doc 02 section 8.2): it names how it is shared or
 * who owns it. A bookmark the caller owns names neither, and the server always sends both, so an absent value reads as none.
 */
export function isSharedWithMe(bookmark: Bookmark): boolean {
  return (bookmark.sharedVia ?? null) !== null || (bookmark.owner ?? null) !== null;
}

/** Whether `value` is an address a bookmark can have, as far as the browser can tell: an `http` or `https` URL. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && URL.canParse(value);
}

/** The problems of the fields of a bookmark to create, from the shared schema of the API contract. */
export function validateCreate(body: CreateBookmarkRequest): FieldProblems {
  return validate(CreateBookmarkRequestSchema.safeParse(body), body.url, body.slug);
}

/** The problems of the fields of a change to a bookmark, from the shared schema of the API contract. */
export function validateUpdate(body: UpdateBookmarkRequest): FieldProblems {
  return validate(UpdateBookmarkRequestSchema.safeParse(body), body.url, body.slug);
}

function validate(result: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; code: string }[] } }, url: string | undefined, slug: string | null | undefined): FieldProblems {
  const problems: Partial<Record<FieldName, FieldProblem>> = result.success || result.error === undefined ? {} : fieldProblemsOf(result.error.issues.map(({ path, code }) => ({ path: String(path[0]), code })));
  // The schema bounds the address; the scheme is the server's rule (doc 02 section 5.1), checked here to spare the round trip.
  if (url !== undefined && problems.url === undefined && !isHttpUrl(url)) {
    problems.url = "notAllowed";
  }
  // The schema takes any text for a slug, since the API trims and lower-cases it first; the form sends it that way already.
  if (typeof slug === "string" && !isValidSlug(slug)) {
    problems.slug = "invalid";
  }
  return problems;
}
