import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The tags tag of doc 04 section 10.7: the operations that create, list, rename, merge and delete a member's tags and report how they are
// used. They act in the workspace the request is bound to and name none (D11). A tag is private to the member who created it (doc 02
// sections 1 and 7.2): another member's tag of the same workspace and any tag of another workspace are answered 404, like one that does
// not exist (doc 04 section 2.4, doc 10 T1 and T2). Attaching tags to bookmarks is done by the bookmark operations.

/** The longest tag name, in characters (doc 02 section 7.2). */
export const TAG_NAME_MAX_LENGTH = 40;

const TagNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(TAG_NAME_MAX_LENGTH)
  .describe(
    "The tag's name, 1 to 40 characters after the whitespace around it is removed. It is stored as entered, in the case it is written in, and is unique among the caller's tags without regard to case",
  );

export const CreateTagRequestSchema = z.strictObject({ name: TagNameSchema }).meta({ id: "CreateTagRequest" });

export const RenameTagRequestSchema = z.strictObject({ name: TagNameSchema }).meta({ id: "RenameTagRequest" });

export const TagSchema = z
  .strictObject({
    id: z.uuid().describe("The tag's identifier"),
    name: z.string().describe("The tag's name, in the case it was entered in"),
    bookmarkCount: z.number().int().min(0).describe("How many of the caller's bookmarks carry the tag; plan-archived bookmarks are not counted"),
    createdAt: z.iso.datetime().describe("When the tag was created, RFC 3339 UTC"),
  })
  .meta({ id: "Tag" });

export const TAG_SORTS = ["name", "count"] as const;

/** The most tags a page returns (doc 04 section 6.1). */
export const TAG_LIST_MAX_LIMIT = 100;

/** The page size when `limit` is left out (doc 04 section 6.1). */
export const TAG_LIST_DEFAULT_LIMIT = 50;

/** Where the total of a list stops being counted (Q42). */
export const TAG_LIST_TOTAL_CAP = 10_000;

/** The longest cursor a client may send back. The largest one the server issues carries a tag name (40 characters, up to 6 bytes each once JSON-escaped), the count, the identifier and the signature, as base64url: about 450 characters. */
export const TAG_CURSOR_MAX_LENGTH = 1024;

export const ListTagsQuerySchema = z.strictObject({
  sort: z
    .enum(TAG_SORTS)
    .default("name")
    .describe("The order: name (alphabetical, ignoring case) or count (most bookmarks first, then by name)"),
  limit: z.coerce.number().int().min(1).max(TAG_LIST_MAX_LIMIT).default(TAG_LIST_DEFAULT_LIMIT).describe("The most tags to return, at most 100"),
  cursor: z
    .string()
    .min(1)
    .max(TAG_CURSOR_MAX_LENGTH)
    .optional()
    .describe("The `nextCursor` of the previous page. It is valid only with the sort it was issued for, for the account and workspace that received it; any other cursor is refused with 400"),
});

export const TagListSchema = z
  .strictObject({
    items: z.array(TagSchema).describe("One page of the caller's tags in the workspace, in the order asked for; another member's tags are never listed"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
    total: z.number().int().min(0).nullable().describe("How many tags the caller has in the workspace, across all pages: exact up to 10 000, and null above that, where totalAtLeast says so"),
    totalAtLeast: z.literal(TAG_LIST_TOTAL_CAP).optional().describe("Present, and 10 000, when total is null: the caller has more than 10 000 tags"),
  })
  .meta({ id: "TagList" });

export const MergeTagRequestSchema = z
  .strictObject({
    intoTagId: z.uuid().describe("The caller's tag that receives the links of the tag in the path; it is not the tag in the path"),
  })
  .meta({ id: "MergeTagRequest" });

/** The most tags the statistics return (doc 04 section 6.1). */
export const TAG_STATS_MAX_LIMIT = 100;

/** The number of tags the statistics return when `limit` is left out. */
export const TAG_STATS_DEFAULT_LIMIT = 50;

export const TagStatsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(TAG_STATS_MAX_LIMIT).default(TAG_STATS_DEFAULT_LIMIT).describe("How many tags to return, the most used first, at most 100"),
});

export const TagStatsSchema = z
  .strictObject({
    items: z.array(TagSchema).describe("The caller's most used tags, most bookmarks first and then by name, each with the number of bookmarks that carry it; plan-archived bookmarks are not counted"),
    total: z.number().int().min(0).nullable().describe("How many tags the caller has in the workspace, whether or not they are in items: exact up to 10 000, and null above that, where totalAtLeast says so"),
    totalAtLeast: z.literal(TAG_LIST_TOTAL_CAP).optional().describe("Present, and 10 000, when total is null: the caller has more than 10 000 tags"),
  })
  .meta({ id: "TagStats" });

export const TagParamsSchema = z.strictObject({
  id: z.uuid().describe("The tag's identifier"),
});

export const createTag = defineOperation({
  method: "post",
  path: "/api/v1/tags",
  operationId: "createTag",
  tag: "tags",
  summary: "Create a tag",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { body: CreateTagRequestSchema },
  responses: {
    201: jsonResponse("The tag, owned by the caller and private to them, with no bookmarks", TagSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    409: problemResponse("The caller already has a tag with this name, in any case (name_taken); nothing is written"),
    422: problemResponse("The body did not pass validation (a name that is blank or longer than 40 characters, or a field the operation does not declare)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const listTags = defineOperation({
  method: "get",
  path: "/api/v1/tags",
  operationId: "listTags",
  tag: "tags",
  summary: "List my tags",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: ListTagsQuerySchema },
  responses: {
    200: jsonResponse("One page of the caller's tags in the workspace in the order asked for, each with the number of bookmarks that carry it, the cursor of the next page and the total (exact up to 10 000, then null with totalAtLeast)", TagListSchema),
    400: problemResponse("The request was malformed, or the cursor is not one this account was issued for this workspace and this sort (bad_request)"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation (an unknown parameter or sort, a limit outside 1 to 100)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const renameTag = defineOperation({
  method: "patch",
  path: "/api/v1/tags/{id}",
  operationId: "renameTag",
  tag: "tags",
  summary: "Rename a tag",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: TagParamsSchema, body: RenameTagRequestSchema },
  responses: {
    200: jsonResponse("The caller's tag under its new name. A name the tag has already, spelled the same, writes nothing and answers the tag as it is", TagSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The workspace the request acts in has no tag of the caller with this identifier: another member's tag, a tag of another workspace and one that never existed are answered alike",
    ),
    409: problemResponse("The caller has another tag with this name, in any case (name_taken); nothing is written. Merging two tags is another operation"),
    422: problemResponse("The identifier or the body did not pass validation (a name that is blank or longer than 40 characters, or a field the operation does not declare)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const deleteTag = defineOperation({
  method: "delete",
  path: "/api/v1/tags/{id}",
  operationId: "deleteTag",
  tag: "tags",
  summary: "Delete a tag",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: TagParamsSchema },
  responses: {
    204: emptyResponse("The tag is deleted for good together with its links to bookmarks; the bookmarks stay"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The workspace the request acts in has no tag of the caller with this identifier: another member's tag, a tag of another workspace, one that never existed and one that was deleted before are answered alike, since a hard delete keeps no tombstone and a repeat is not answered 204",
    ),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const mergeTag = defineOperation({
  method: "post",
  path: "/api/v1/tags/{id}/merge",
  operationId: "mergeTag",
  tag: "tags",
  summary: "Merge a tag into another",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: TagParamsSchema, body: MergeTagRequestSchema },
  responses: {
    200: jsonResponse(
      "The target tag with its new count. Every bookmark that carried the tag in the path now carries the target, a bookmark that carried both carries the target once, and the tag in the path is deleted for good; the bookmarks stay",
      TagSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The workspace the request acts in has no tag of the caller with the identifier in the path, or none with `intoTagId`: another member's tag, a tag of another workspace and one that never existed are answered alike, for either of them, and nothing is changed",
    ),
    422: problemResponse("The identifier or the body did not pass validation, or `intoTagId` is the tag in the path (validation_failed on `intoTagId`, code same_tag); nothing is changed"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const getTagStats = defineOperation({
  method: "get",
  path: "/api/v1/tags/stats",
  operationId: "getTagStats",
  tag: "tags",
  summary: "Get the distribution of my tags",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: TagStatsQuerySchema },
  responses: {
    200: jsonResponse("The caller's most used tags with their counts, and how many tags the caller has in all (exact up to 10 000, then null with totalAtLeast)", TagStatsSchema),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation (an unknown parameter, a limit outside 1 to 100)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
