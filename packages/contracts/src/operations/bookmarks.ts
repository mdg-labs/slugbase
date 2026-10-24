import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The bookmarks tag of doc 04 section 10.6: the operations that create a bookmark, read it back, change it and delete it. They
// act in the workspace the request is bound to and name none (D11), and a bookmark is its owner's: another member's bookmark of
// the same workspace and any bookmark of another workspace are answered 404, like one that does not exist (doc 04 section 2.4,
// doc 10 T1 and T2). The URL is stored normalised and only `http` and `https` are stored (doc 02 section 5.1, doc 10 T12 and
// T13). The list pages through the caller's own bookmarks by a signed keyset cursor (doc 04 section 6.1). An open records that the
// caller used a bookmark and answers the destination to go to (doc 02 section 5.5). The slug and the folders and tags of a bookmark
// are other operations. A bulk request deletes, pins or unpins many of the caller's own bookmarks at once, named by identifier or by the
// list's filters, in one transaction; the select-all operation returns the identifiers a filter matches so a client can name them.

/** The longest bookmark URL, in characters (doc 02 section 5.1). */
export const BOOKMARK_URL_MAX_LENGTH = 2048;

/** The longest bookmark title, in characters (doc 02 section 5.1). */
export const BOOKMARK_TITLE_MAX_LENGTH = 300;

/** The longest bookmark description, in characters (doc 02 section 5.1). */
export const BOOKMARK_DESCRIPTION_MAX_LENGTH = 1000;

export const CreateBookmarkRequestSchema = z
  .strictObject({
    url: z
      .string()
      .min(1)
      .max(BOOKMARK_URL_MAX_LENGTH)
      .describe(
        "The address to save: an http or https URL of at most 2 048 characters. It is stored with a lower-case scheme and host, an internationalised host name in punycode, the default port left out and the fragment kept. Any other scheme is refused with 422 url_not_allowed",
      ),
    title: z.string().trim().min(1).max(BOOKMARK_TITLE_MAX_LENGTH).describe("The bookmark's title, 1 to 300 characters; surrounding whitespace is removed and a title that is blank after that is refused"),
    description: z
      .string()
      .trim()
      .max(BOOKMARK_DESCRIPTION_MAX_LENGTH)
      .optional()
      .describe("The bookmark's description, 0 to 1 000 characters; surrounding whitespace is removed and an empty one is stored as none"),
    pinned: z.boolean().optional().describe("Whether the bookmark is pinned; not pinned when left out"),
  })
  .meta({ id: "CreateBookmarkRequest" });

export const UpdateBookmarkRequestSchema = z
  .strictObject({
    url: z
      .string()
      .min(1)
      .max(BOOKMARK_URL_MAX_LENGTH)
      .optional()
      .describe(
        "The new address: an http or https URL of at most 2 048 characters, stored as a creation stores it; the canonical form and the host are derived again. Any other scheme is refused with 422 url_not_allowed. Left out, the address is left as it is",
      ),
    title: z.string().trim().min(1).max(BOOKMARK_TITLE_MAX_LENGTH).optional().describe("The new title, 1 to 300 characters; surrounding whitespace is removed and a title that is blank after that is refused. It cannot be cleared. Left out, the title is left as it is"),
    description: z
      .string()
      .trim()
      .max(BOOKMARK_DESCRIPTION_MAX_LENGTH)
      .nullable()
      .optional()
      .describe("The new description, 0 to 1 000 characters; surrounding whitespace is removed, and an empty one and null clear it. Left out, the description is left as it is"),
    pinned: z.boolean().optional().describe("Pins or unpins the bookmark; left out, the pin is left as it is"),
  })
  .meta({ id: "UpdateBookmarkRequest" });

export const BookmarkSchema = z
  .strictObject({
    id: z.uuid().describe("The bookmark's identifier"),
    ownerId: z.uuid().nullable().describe("The account of the member who owns the bookmark; null once that member has left the workspace"),
    url: z.string().describe("The URL as stored: normalised, and always http or https"),
    host: z.string().describe("The host name of the URL, lower case and in punycode"),
    title: z.string().describe("The bookmark's title"),
    description: z.string().nullable().describe("The bookmark's description, null when it has none"),
    slug: z.string().nullable().describe("The bookmark's slug, null when it has none"),
    forwarding: z.boolean().describe("Whether /go forwards to the bookmark by its slug"),
    pinned: z.boolean().describe("Whether the bookmark is pinned"),
    openCount: z.number().int().min(0).describe("How many times the bookmark was opened"),
    lastOpenedAt: z.iso.datetime().nullable().describe("When the bookmark was last opened, RFC 3339 UTC, null when it never was"),
    version: z.number().int().min(1).describe("Moves by one with every change; the ETag header carries it and If-Match takes it back"),
    createdAt: z.iso.datetime().describe("When the bookmark was created, RFC 3339 UTC"),
    updatedAt: z.iso.datetime().describe("When the bookmark last changed, RFC 3339 UTC"),
  })
  .meta({ id: "Bookmark" });

/** The most bookmarks a page returns (doc 04 section 6.1). */
export const BOOKMARK_LIST_MAX_LIMIT = 100;

/** The page size when `limit` is left out (doc 04 section 6.1). */
export const BOOKMARK_LIST_DEFAULT_LIMIT = 48;

/** Where the total of a list stops being counted (Q42). */
export const BOOKMARK_LIST_TOTAL_CAP = 10_000;

/**
 * The longest cursor a client may send back. The largest one the server issues carries the lower-cased title of the last item
 * (300 characters, up to 6 bytes each once JSON-escaped), the identifier and the signature, as base64url: about 2 600 characters.
 */
export const BOOKMARK_CURSOR_MAX_LENGTH = 4096;

export const BookmarkSortSchema = z.enum(["recent", "oldest", "title_asc", "title_desc", "most_used", "recently_opened"]);

const QueryBooleanSchema = z.enum(["true", "false"]);

export const ListBookmarksQuerySchema = z.strictObject({
  scope: z.enum(["all", "mine"]).default("all").describe("Whose bookmarks are listed. Only the caller's own bookmarks exist until sharing arrives, so both name the same bookmarks today"),
  pinned: QueryBooleanSchema.optional().describe("true lists pinned bookmarks only and false unpinned ones only; left out, pinning is not filtered on"),
  hasSlug: QueryBooleanSchema.optional().describe("true lists bookmarks with a slug only and false those without one; left out, slugs are not filtered on"),
  forwarding: QueryBooleanSchema.optional().describe("true lists the bookmarks /go forwards to only and false those it does not; left out, forwarding is not filtered on"),
  url: z
    .string()
    .min(1)
    .max(BOOKMARK_URL_MAX_LENGTH)
    .optional()
    .describe(
      "Lists the caller's bookmarks whose canonical URL equals the canonical form of this value, which the duplicate warning of a new bookmark uses. The value is normalised as a bookmark's URL is, and one that cannot be a bookmark's URL is refused with 422",
    ),
  sort: BookmarkSortSchema.default("recent").describe(
    "The order, with the identifier as the tiebreak: recent (newest first), oldest, title_asc and title_desc (by title, ignoring case), most_used (most opens first) or recently_opened (last opened first, never-opened bookmarks last)",
  ),
  limit: z.coerce.number().int().min(1).max(BOOKMARK_LIST_MAX_LIMIT).default(BOOKMARK_LIST_DEFAULT_LIMIT).describe("The most bookmarks to return, at most 100"),
  cursor: z
    .string()
    .min(1)
    .max(BOOKMARK_CURSOR_MAX_LENGTH)
    .optional()
    .describe("The `nextCursor` of the previous page. It is valid only with the scope, filters and sort it was issued for, for the account and workspace that received it; any other cursor is refused with 400"),
});

export const BookmarkListSchema = z
  .strictObject({
    items: z.array(BookmarkSchema).describe("One page of the caller's bookmarks, in the order asked for; plan-archived bookmarks are never listed"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
    total: z.number().int().min(0).nullable().describe("How many bookmarks match the filters, across all pages: exact up to 10 000, and null above that, where totalAtLeast says so"),
    totalAtLeast: z.literal(BOOKMARK_LIST_TOTAL_CAP).optional().describe("Present, and 10 000, when total is null: the filters match more than 10 000 bookmarks"),
  })
  .meta({ id: "BookmarkList" });

/** The most identifiers a bulk request names (doc 04 section 6.2). */
export const BOOKMARK_BULK_IDS_MAX = 1000;

/**
 * The most bookmarks a select-all returns and a bulk request by filter acts on (doc 02 section 16, which doc 04 section 6.2 repeats).
 * It is a fixed value of this release: doc 07 declares no key for it.
 */
export const BOOKMARK_SELECT_ALL_CAP = 5000;

export const BULK_BOOKMARK_ACTIONS = ["delete", "pin", "unpin"] as const;

export const BookmarkFilterSchema = z
  .strictObject({
    scope: z.enum(["all", "mine"]).optional().describe("Whose bookmarks are matched. Only the caller's own bookmarks exist until sharing arrives, so both name the same bookmarks today; mine when left out"),
    pinned: z.boolean().optional().describe("true matches pinned bookmarks only and false unpinned ones only; left out, pinning is not filtered on"),
    hasSlug: z.boolean().optional().describe("true matches bookmarks with a slug only and false those without one; left out, slugs are not filtered on"),
    forwarding: z.boolean().optional().describe("true matches the bookmarks /go forwards to only and false those it does not; left out, forwarding is not filtered on"),
    url: z
      .string()
      .min(1)
      .max(BOOKMARK_URL_MAX_LENGTH)
      .optional()
      .describe("Matches the caller's bookmarks whose canonical URL equals the canonical form of this value; one that cannot be a bookmark's URL is refused with 422"),
  })
  .meta({ id: "BookmarkFilter" });

export const BulkBookmarksRequestSchema = z
  .strictObject({
    action: z.enum(BULK_BOOKMARK_ACTIONS).describe("delete removes the bookmarks for good, pin pins them and unpin unpins them"),
    ids: z
      .array(z.uuid())
      .min(1)
      .max(BOOKMARK_BULK_IDS_MAX)
      .optional()
      .describe("The bookmarks to act on, 1 to 1 000 identifiers; one named twice counts once. Give this or filter, and not both"),
    filter: BookmarkFilterSchema.optional().describe(
      "Acts on the caller's bookmarks that match this filter, which is the list's filters; a filter that matches more than 5 000 bookmarks is refused with 422. Give this or ids, and not both",
    ),
  })
  .refine((request) => (request.ids === undefined) !== (request.filter === undefined), { message: "name either ids or filter" })
  .meta({ id: "BulkBookmarksRequest" });

export const BulkBookmarksResultSchema = z
  .strictObject({
    requested: z.number().int().min(0).describe("How many bookmarks the request named (the distinct identifiers) or the filter matched"),
    affected: z.number().int().min(0).describe("How many of them are now deleted, or are pinned or unpinned as asked (a bookmark that already was is counted)"),
    skipped: z.number().int().min(0).describe("How many were left alone: requested minus affected"),
    skippedReasons: z
      .strictObject({
        not_owner: z.number().int().min(0).describe("Bookmarks the caller can read and does not own; none exist until sharing arrives"),
        not_found: z
          .number()
          .int()
          .min(0)
          .describe("Bookmarks the caller owns none of in this workspace: another member's, another workspace's, one that is gone, and, for pin and unpin, a plan-archived one. They are not told apart"),
      })
      .describe("The skipped bookmarks by reason, as counts only"),
  })
  .meta({ id: "BulkBookmarksResult" });

export const BookmarkIdsQuerySchema = ListBookmarksQuerySchema.omit({ sort: true, limit: true, cursor: true });

export const BookmarkIdsSchema = z
  .strictObject({
    ids: z.array(z.uuid()).max(BOOKMARK_SELECT_ALL_CAP).describe("The identifiers of the caller's bookmarks that match the filters, newest first, at most 5 000"),
    truncated: z.boolean().describe("true when more than 5 000 bookmarks match, so ids holds the first 5 000 only and a bulk request by the same filter is refused"),
  })
  .meta({ id: "BookmarkIds" });

export const BookmarkOpenSchema = z
  .strictObject({
    url: z.string().describe("The destination to go to: the bookmark's URL as stored, checked again to be an http or https URL"),
  })
  .meta({ id: "BookmarkOpen" });

export const BookmarkParamsSchema = z.strictObject({
  id: z.uuid().describe("The bookmark's identifier"),
});

/** The precondition of doc 04 section 2.4: the `ETag` of the version the caller read, as a quoted entity tag, or `*`. */
export const BookmarkIfMatchHeaderSchema = z.object({
  "If-Match": z
    .string()
    .optional()
    .describe('The ETag of the version the change is made against, for example "3". A bookmark at another version answers 412 precondition_failed. Optional, so an API token may leave it out; `*` matches any version'),
});

const BookmarkEntityTag = {
  ETag: { description: 'The bookmark\'s version as an entity tag, for example "3"; the If-Match of the next change', schema: z.string() },
} as const;

export const createBookmark = defineOperation({
  method: "post",
  path: "/api/v1/bookmarks",
  operationId: "createBookmark",
  tag: "bookmarks",
  summary: "Create a bookmark",
  auth: "member",
  rate: "write",
  scope: "write",
  idempotency: true,
  request: { body: CreateBookmarkRequestSchema },
  responses: {
    201: jsonResponse(
      "The bookmark, owned by the caller and private to them, with its id and its version in the body (the ETag of a later read repeats the version). The workspace's bookmark count is raised by one in the same transaction, and bookmark.created is announced once it is committed. A retry with the same Idempotency-Key and the same request answers this response again with Idempotency-Replayed: true and stores nothing; a replay restores the status and the body and no header, so the response carries none",
      BookmarkSchema,
    ),
    400: problemResponse("The request was malformed, or the Idempotency-Key header is not a UUID"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    409: problemResponse("The Idempotency-Key was used before for another request (idempotency_conflict); nothing is written"),
    422: problemResponse(
      "The body did not pass validation (a missing, empty or over-long URL, title or description, a malformed URL, or a field the operation does not declare), the URL is not an http or https URL (url_not_allowed), or the workspace already holds as many bookmarks as its bookmarks.max entitlement allows (bookmark_limit_reached; the problem carries limit and used). Nothing is written, and a refused request keeps no key, so a retry with it runs",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse(
      "The service is temporarily unavailable, the entitlement source could not say how many bookmarks the workspace may hold, or an earlier request with the same Idempotency-Key is still running",
    ),
  },
});

export const listBookmarks = defineOperation({
  method: "get",
  path: "/api/v1/bookmarks",
  operationId: "listBookmarks",
  tag: "bookmarks",
  summary: "List bookmarks",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: ListBookmarksQuerySchema },
  responses: {
    200: jsonResponse(
      "One page of the caller's bookmarks in the order asked for, with the cursor of the next page and the total the filters match (exact up to 10 000, then null with totalAtLeast). Another member's bookmarks, those of another workspace and plan-archived ones are never listed",
      BookmarkListSchema,
    ),
    400: problemResponse("The request was malformed, or the cursor is not one this account was issued for this workspace, these filters and this sort (bad_request)"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation (an unknown parameter or sort, a boolean other than true or false, a limit outside 1 to 100), or the url is not a URL a bookmark can have"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const getBookmark = defineOperation({
  method: "get",
  path: "/api/v1/bookmarks/{id}",
  operationId: "getBookmark",
  tag: "bookmarks",
  summary: "Read a bookmark",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { params: BookmarkParamsSchema },
  responses: {
    200: jsonResponse("The caller's bookmark", BookmarkSchema, { headers: BookmarkEntityTag }),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse(
      "The workspace the request acts in has no bookmark of the caller with this identifier: another member's bookmark, a bookmark of another workspace and one that never existed are answered alike",
    ),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const updateBookmark = defineOperation({
  method: "patch",
  path: "/api/v1/bookmarks/{id}",
  operationId: "updateBookmark",
  tag: "bookmarks",
  summary: "Change a bookmark",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: BookmarkParamsSchema, headers: BookmarkIfMatchHeaderSchema, body: UpdateBookmarkRequestSchema },
  responses: {
    200: jsonResponse(
      "The caller's bookmark after a JSON Merge Patch of its url, title, description and pinned fields. A change moves the version by one and the ETag is that of the new version; a patch that names the values the bookmark has, and an empty one, write nothing and answer with the unchanged version",
      BookmarkSchema,
      { headers: BookmarkEntityTag },
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The workspace the request acts in has no bookmark of the caller with this identifier that can be changed: another member's bookmark, a bookmark of another workspace, a plan-archived one and one that never existed are answered alike",
    ),
    412: problemResponse("If-Match names a version other than the bookmark's current one (precondition_failed); the bookmark is unchanged"),
    422: problemResponse(
      "The identifier or the body did not pass validation (a malformed, empty or over-long URL, a title that is blank or over-long, a description over 1 000 characters, a null title or URL, or a field the operation does not declare), or the URL is not an http or https URL (url_not_allowed). Nothing is written",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const deleteBookmark = defineOperation({
  method: "delete",
  path: "/api/v1/bookmarks/{id}",
  operationId: "deleteBookmark",
  tag: "bookmarks",
  summary: "Delete a bookmark",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: BookmarkParamsSchema },
  responses: {
    204: emptyResponse(
      "The bookmark is deleted for good: the rows that reference it (folder and tag links, shares, go preferences) go with it, its slug is free at once, and the workspace's bookmark count falls by one unless the bookmark was plan-archived",
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The workspace the request acts in has no bookmark of the caller with this identifier: another member's bookmark, a bookmark of another workspace, one that never existed and one that was deleted before are answered alike, since a hard delete keeps no tombstone and a repeat is not answered 204",
    ),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const openBookmark = defineOperation({
  method: "post",
  path: "/api/v1/bookmarks/{id}/open",
  operationId: "openBookmark",
  tag: "bookmarks",
  summary: "Record an open of a bookmark",
  auth: "member",
  rate: "go",
  scope: "write",
  request: { params: BookmarkParamsSchema },
  responses: {
    200: jsonResponse(
      "The destination of the bookmark. The open is counted asynchronously: the bookmark's open count and last opened time follow within seconds, and only that count and the latest time are kept, with no history, referrer or address",
      BookmarkOpenSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The workspace the request acts in has no bookmark of the caller with this identifier: another member's bookmark, a bookmark of another workspace, a plan-archived one and one that never existed are answered alike, and nothing is counted",
    ),
    422: problemResponse("The identifier did not pass validation, or the stored URL is not an http or https URL (url_not_allowed); nothing is counted"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const listBookmarkIds = defineOperation({
  method: "get",
  path: "/api/v1/bookmarks/ids",
  operationId: "listBookmarkIds",
  tag: "bookmarks",
  summary: "List the identifiers of the bookmarks a filter matches",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: BookmarkIdsQuerySchema },
  responses: {
    200: jsonResponse(
      "The identifiers of the caller's bookmarks that match the filters of the list, newest first, up to the select-all cap of 5 000, and whether more matched. Another member's bookmarks, those of another workspace and plan-archived ones are never returned",
      BookmarkIdsSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation (an unknown parameter, a boolean other than true or false), or the url is not a URL a bookmark can have"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const bulkBookmarks = defineOperation({
  method: "post",
  path: "/api/v1/bookmarks/bulk",
  operationId: "bulkBookmarks",
  tag: "bookmarks",
  summary: "Delete, pin or unpin many bookmarks",
  auth: "member",
  rate: "bulk",
  scope: "write",
  request: { body: BulkBookmarksRequestSchema },
  responses: {
    200: jsonResponse(
      "What the request did, as counts only. The whole request is one transaction: every bookmark it affects changes or none does. Only the caller's own bookmarks change; the others are skipped as not_found without saying whether they exist. A delete gives the workspace's bookmark count back once for the request, by the bookmarks that were not plan-archived, and records one bookmark.bulk_deleted audit event with the number deleted, never a title or a URL",
      BulkBookmarksResultSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse(
      "The body did not pass validation (an unknown action, neither or both of ids and filter, no identifier or more than 1 000, a malformed identifier, a field the operation does not declare), the filter's url is not a URL a bookmark can have, or the filter matches more than the select-all cap of 5 000 bookmarks. Nothing is written",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
