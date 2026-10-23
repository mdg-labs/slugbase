import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The bookmarks tag of doc 04 section 10.6: the operations that create a bookmark, read it back, change it and delete it. They
// act in the workspace the request is bound to and name none (D11), and a bookmark is its owner's: another member's bookmark of
// the same workspace and any bookmark of another workspace are answered 404, like one that does not exist (doc 04 section 2.4,
// doc 10 T1 and T2). The URL is stored normalised and only `http` and `https` are stored (doc 02 section 5.1, doc 10 T12 and
// T13). Listing, the slug and the folders and tags of a bookmark are other operations.

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
