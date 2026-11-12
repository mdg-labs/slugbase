import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { FOLDER_COLOR_MAX, FOLDER_COLOR_MIN } from "./folders.ts";

// The operations of doc 04 section 10.5 that list the former members' content of the workspace the request acts in (doc 02 sections 2.10 and 3.6): the
// bookmarks and folders that have no owner because their owner left the workspace or deleted their account. They are an admin's, are session-only
// (they declare no token scope, so an API token never reaches them) and name no row, so they take no identifier. A row that still waits for the
// content choice of the member who left (doc 05 section 7.5) is not listed, and neither is a plan-archived bookmark. The deletion of that content is an admin's
// too and acts on the rows the lists hold and on no other.

/** The most identifiers of one list a deletion names (doc 04 section 10.5), the bound of folder filing (doc 04 section 10.7). */
export const FORMER_CONTENT_DELETE_MAX = 1000;

export const FormerBookmarkSchema = z
  .strictObject({
    id: z.uuid().describe("The bookmark's identifier"),
    title: z.string().describe("The bookmark's title"),
    url: z.string().describe("The URL as stored: normalised, and always http or https"),
    host: z.string().describe("The host name of the URL, lower case and in punycode"),
    slug: z.string().nullable().describe("The bookmark's slug, null when it has none"),
    forwarding: z.boolean().describe("Whether /go forwards to the bookmark by its slug"),
    createdAt: z.iso.datetime().describe("When the bookmark was created, RFC 3339 UTC"),
    updatedAt: z.iso.datetime().describe("When the bookmark last changed, RFC 3339 UTC"),
  })
  .meta({ id: "FormerBookmark" });

export const FormerBookmarkListSchema = z
  .strictObject({
    items: z.array(FormerBookmarkSchema).describe("One page of the workspace's bookmarks that have no owner, in the order of their identifiers, which is the order they were created in"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
  })
  .meta({ id: "FormerBookmarkList" });

export const FormerFolderSchema = z
  .strictObject({
    id: z.uuid().describe("The folder's identifier"),
    name: z.string().describe("The folder's name, in the case it was entered in"),
    icon: z.string().describe("The folder's icon, a lucide icon name"),
    color: z.number().int().min(FOLDER_COLOR_MIN).max(FOLDER_COLOR_MAX).describe("The folder's colour, 1 to 8: the number of the --folder-N theme token"),
    bookmarkCount: z
      .number()
      .int()
      .min(0)
      .describe("How many of the bookmarks that this list of bookmarks holds are filed in the folder: the ones that have no owner, are not waiting for the content choice of a member who left and are not plan-archived"),
    createdAt: z.iso.datetime().describe("When the folder was created, RFC 3339 UTC"),
  })
  .meta({ id: "FormerFolder" });

export const FormerFolderListSchema = z
  .strictObject({
    items: z.array(FormerFolderSchema).describe("One page of the workspace's folders that have no owner, in the order of their identifiers, which is the order they were created in"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
  })
  .meta({ id: "FormerFolderList" });

export const FormerContentListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50).describe("The most rows to return, at most 100"),
  cursor: z.string().min(1).max(512).optional().describe("The `nextCursor` of the previous page; valid only for the workspace and the list that issued it"),
});

export const listFormerBookmarks = defineOperation({
  method: "get",
  path: "/api/v1/workspace/former-content/bookmarks",
  operationId: "listFormerBookmarks",
  tag: "members",
  summary: "List the bookmarks of former members",
  auth: "admin",
  rate: "read",
  request: { query: FormerContentListQuerySchema },
  responses: {
    200: jsonResponse(
      "One page of the active workspace's bookmarks that have no owner: those of a member who left or whose account was deleted. A bookmark that has an owner, one that still waits for the content choice of a member who left and one the plan archived are not listed, and no bookmark of another workspace is",
      FormerBookmarkListSchema,
    ),
    400: problemResponse("The request was malformed, or the cursor is not one this workspace issued for this list"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, the caller is a member and not an admin or owner of the workspace (forbidden), or the account is in the export-only period (account_export_only)",
    ),
    404: problemResponse("The request acts in no workspace, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const listFormerFolders = defineOperation({
  method: "get",
  path: "/api/v1/workspace/former-content/folders",
  operationId: "listFormerFolders",
  tag: "members",
  summary: "List the folders of former members",
  auth: "admin",
  rate: "read",
  request: { query: FormerContentListQuerySchema },
  responses: {
    200: jsonResponse(
      "One page of the active workspace's folders that have no owner: those of a member who left or whose account was deleted, each with how many of the bookmarks listed by listFormerBookmarks are filed in it. A folder that has an owner and one that still waits for the content choice of a member who left are not listed, and no folder of another workspace is",
      FormerFolderListSchema,
    ),
    400: problemResponse("The request was malformed, or the cursor is not one this workspace issued for this list"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, the caller is a member and not an admin or owner of the workspace (forbidden), or the account is in the export-only period (account_export_only)",
    ),
    404: problemResponse("The request acts in no workspace, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const DeleteFormerContentRequestSchema = z
  .strictObject({
    bookmarkIds: z
      .array(z.uuid())
      .min(1)
      .max(FORMER_CONTENT_DELETE_MAX)
      .optional()
      .describe("The bookmarks to delete, 1 to 1 000 identifiers; one named twice counts once. Give this, folderIds or both"),
    folderIds: z
      .array(z.uuid())
      .min(1)
      .max(FORMER_CONTENT_DELETE_MAX)
      .optional()
      .describe("The folders to delete, 1 to 1 000 identifiers; one named twice counts once. Give this, bookmarkIds or both"),
  })
  .refine((request) => request.bookmarkIds !== undefined || request.folderIds !== undefined, { message: "name at least one bookmark or folder" })
  .meta({ id: "DeleteFormerContentRequest" });

export const DeleteFormerContentResultSchema = z
  .strictObject({
    bookmarksDeleted: z.number().int().min(0).describe("How many of the named bookmarks were deleted"),
    foldersDeleted: z.number().int().min(0).describe("How many of the named folders were deleted"),
  })
  .meta({ id: "DeleteFormerContentResult" });

export const deleteFormerContent = defineOperation({
  method: "post",
  path: "/api/v1/workspace/former-content/delete",
  operationId: "deleteFormerContent",
  tag: "members",
  summary: "Delete the bookmarks and folders of former members",
  auth: "admin",
  rate: "write",
  request: { body: DeleteFormerContentRequestSchema },
  responses: {
    200: jsonResponse(
      "What the request deleted, as counts only. It deletes the named bookmarks and folders of the active workspace that have no owner, with their shares, filings, tag links and remembered go choices, for good: there is no trash and no undo. The whole request is one transaction: the rows, the workspace's bookmark count (which falls by the bookmarks deleted) and the audit event commit or roll back together. An identifier that names no such row is skipped and not told apart from another: a bookmark or folder that has an owner, one that still waits for the content choice of a member who left, a plan-archived bookmark, one of another workspace and an unknown one are never deleted, and the answer does not say whether they exist, so a request that deletes nothing is an ordinary 200 with zero counts. A request that deletes something records one member.former_content_deleted audit event with the number of bookmarks and of folders, never a title, a URL or an identifier; one that deletes nothing records none",
      DeleteFormerContentResultSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, the caller is a member and not an admin or owner of the workspace (forbidden), or the account is in the export-only period (account_export_only); nothing is deleted",
    ),
    404: problemResponse(
      "The request acts in no workspace, or the workspace is being deleted, or the caller stopped being an owner or admin of the workspace between the authorization of the request and its deletion; nothing is deleted",
    ),
    422: problemResponse("The body did not pass validation (neither list given, a list that is empty or holds more than 1 000 identifiers, a malformed identifier, a field the operation does not declare)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
