import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { withoutNul } from "./text.ts";

// The sharing tag of doc 04 section 10.7: the operations that find the members and teams a bookmark or a folder can be shared with and that grant, list and
// revoke the shares of a bookmark or a folder of the workspace the request is bound to. They act in the workspace of the request and name none (D11). Only the
// owner of a bookmark or a folder lists, grants or revokes its shares; one that is another member's and not shared with the caller, ownerless and not shared with the caller, another workspace's or unknown is the same 404
// (doc 04 section 2.4, doc 10 T1 and T2), except a bookmark or a folder that is shared with the caller, who does not own it (another member's, or ownerless), can read it and may not share it further or see its shares: 403 forbidden (doc 02 section 8.2). A share of a folder gives read access to every bookmark filed in it, now and later (doc 02 section 8.1). Sharing needs `sharing.members` or `sharing.teams`, by the kind of target; the server decides that in the
// handler, since the kind is in the request (doc 01 section 7.5, doc 10 T11). The two reads are the session's alone, like the lists of other members'
// data; granting and revoking take the `write` token scope.

/** The most targets one search returns (doc 03). */
export const SHARE_TARGET_LIST_MAX_LIMIT = 50;

/** The number of targets a search returns when `limit` is left out. */
export const SHARE_TARGET_LIST_DEFAULT_LIMIT = 20;

/** The longest text a search takes, in characters. */
export const SHARE_TARGET_SEARCH_MAX_LENGTH = 100;

export const SHARE_TARGET_KINDS = ["member", "team"] as const;

const TargetKindSchema = z.enum(SHARE_TARGET_KINDS).describe("What the target is: a member of the workspace, or one of its teams");

export const ListShareTargetsQuerySchema = z.strictObject({
  q: withoutNul(z.string().trim().min(1).max(SHARE_TARGET_SEARCH_MAX_LENGTH))
    .optional()
    .describe("Lists the targets whose name contains this text, or, for a member, whose email address does, without regard to case; left out, every target is listed"),
  limit: z.coerce.number().int().min(1).max(SHARE_TARGET_LIST_MAX_LIMIT).default(SHARE_TARGET_LIST_DEFAULT_LIMIT).describe("The most targets to return, at most 50"),
});

export const ShareTargetSchema = z
  .strictObject({
    kind: TargetKindSchema,
    id: z.uuid().describe("The account identifier of a member, the team identifier of a team"),
    name: z.string().describe("The display name of a member, the name of a team"),
    email: z.string().nullable().describe("The member's email address, which every co-member of the workspace sees; null for a team"),
  })
  .meta({ id: "ShareTarget" });

export const ShareTargetListSchema = z
  .strictObject({
    items: z.array(ShareTargetSchema).describe("The members of the workspace other than the caller and the teams of the workspace that match, ordered by name (ignoring case) and then identifier. A kind the workspace has no sharing entitlement for is left out"),
  })
  .meta({ id: "ShareTargetList" });

export const CreateBookmarkShareRequestSchema = z
  .union([
    z.strictObject({ accountId: z.uuid().describe("The account identifier of the member to share the bookmark with; it must be a current member of the workspace other than the caller") }),
    z.strictObject({ teamId: z.uuid().describe("The identifier of the team to share the bookmark with; it must be a team of the workspace") }),
  ])
  .meta({ id: "CreateBookmarkShareRequest" });

export const BookmarkShareSchema = z
  .strictObject({
    id: z.uuid().describe("The share's identifier"),
    kind: TargetKindSchema,
    accountId: z.uuid().nullable().describe("The account identifier of the member the bookmark is shared with; null for a team"),
    teamId: z.uuid().nullable().describe("The identifier of the team the bookmark is shared with; null for a member"),
    name: z.string().describe("The display name of the member, the name of the team"),
    email: z.string().nullable().describe("The member's email address, which every co-member of the workspace sees; null for a team"),
    createdAt: z.iso.datetime().describe("When the bookmark was shared with the target, RFC 3339 UTC"),
  })
  .meta({ id: "BookmarkShare" });

export const BookmarkShareListSchema = z
  .strictObject({
    items: z.array(BookmarkShareSchema).describe("The shares of the bookmark, oldest first"),
    audienceSize: z.number().int().min(0).describe("How many distinct members other than the owner can read the bookmark through its shares: the members it is shared with and the members of the teams it is shared with"),
  })
  .meta({ id: "BookmarkShareList" });

export const BookmarkSharesParamsSchema = z.strictObject({
  id: z.uuid().describe("The bookmark's identifier"),
});

export const BookmarkShareParamsSchema = z.strictObject({
  id: z.uuid().describe("The bookmark's identifier"),
  shareId: z.uuid().describe("The share's identifier"),
});

export const CreateFolderShareRequestSchema = z
  .union([
    z.strictObject({ accountId: z.uuid().describe("The account identifier of the member to share the folder with; it must be a current member of the workspace other than the caller") }),
    z.strictObject({ teamId: z.uuid().describe("The identifier of the team to share the folder with; it must be a team of the workspace") }),
  ])
  .meta({ id: "CreateFolderShareRequest" });

export const FolderShareSchema = z
  .strictObject({
    id: z.uuid().describe("The share's identifier"),
    kind: TargetKindSchema,
    accountId: z.uuid().nullable().describe("The account identifier of the member the folder is shared with; null for a team"),
    teamId: z.uuid().nullable().describe("The identifier of the team the folder is shared with; null for a member"),
    name: z.string().describe("The display name of the member, the name of the team"),
    email: z.string().nullable().describe("The member's email address, which every co-member of the workspace sees; null for a team"),
    createdAt: z.iso.datetime().describe("When the folder was shared with the target, RFC 3339 UTC"),
  })
  .meta({ id: "FolderShare" });

export const FolderShareListSchema = z
  .strictObject({
    items: z.array(FolderShareSchema).describe("The shares of the folder, oldest first"),
    audienceSize: z.number().int().min(0).describe("How many distinct members other than the owner can read the folder, and the bookmarks in it, through its shares: the members it is shared with and the members of the teams it is shared with"),
  })
  .meta({ id: "FolderShareList" });

export const FolderSharesParamsSchema = z.strictObject({
  id: z.uuid().describe("The folder's identifier"),
});

export const FolderShareParamsSchema = z.strictObject({
  id: z.uuid().describe("The folder's identifier"),
  shareId: z.uuid().describe("The share's identifier"),
});

const NO_SESSION = "There is no session, or its second factor is not complete";
const NO_WORKSPACE = "The request acts in no workspace: the account has none, or the workspace is being deleted";
const NO_BOOKMARK =
  "The workspace the request acts in has no bookmark of the caller with this identifier and none shared with them: another member's bookmark that is not shared with the caller, a bookmark whose owner has left the workspace and that is not shared with the caller, a bookmark of another workspace and one that never existed are answered alike";
const SHARED_WITH_CALLER = ", or the bookmark is shared with the caller, who does not own it, can read it and may not see or change its shares (forbidden): another member's, or one whose owner has left the workspace and that is still shared with them";
const SHARED_FOLDER_WITH_CALLER = ", or the folder is shared with the caller, who does not own it, can read it and may not see or change its shares (forbidden): another member's, or one whose owner has left the workspace and that is still shared with them";
const NO_FOLDER =
  "The workspace the request acts in has no folder of the caller with this identifier and none shared with them: another member's folder that is not shared with the caller, a folder whose owner has left the workspace and that is not shared with the caller, a folder of another workspace and one that never existed are answered alike";
const READ_REFUSED =
  "The credential is an API token, or the workspace holds neither the sharing.members nor the sharing.teams entitlement (entitlement_required; the problem carries entitlement and upgradeAvailable)";
const WRITE_REFUSED =
  "The request did not come from the application itself (cross_site_request), the credential is an API token that may only read (token_scope), or the workspace does not hold the entitlement of the kind of target: sharing.members for a member, sharing.teams for a team (entitlement_required; the problem carries entitlement and upgradeAvailable)";
const REVOKE_REFUSED =
  "The request did not come from the application itself (cross_site_request), the credential is an API token that may only read (token_scope), or the workspace holds neither the sharing.members nor the sharing.teams entitlement (entitlement_required; the problem carries entitlement and upgradeAvailable)";
const RATE_LIMITED = "Too many requests; Retry-After says when to try again";
const UNAVAILABLE = "The service is temporarily unavailable";

export const listShareTargets = defineOperation({
  method: "get",
  path: "/api/v1/share-targets",
  operationId: "listShareTargets",
  tag: "sharing",
  summary: "Find the members and teams to share with",
  auth: "member",
  rate: "read",
  request: { query: ListShareTargetsQuerySchema },
  responses: {
    200: jsonResponse("The members (other than the caller) and the teams of the workspace that match, for the kinds the workspace may share with", ShareTargetListSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    403: problemResponse(READ_REFUSED),
    404: problemResponse(NO_WORKSPACE),
    422: problemResponse("The query did not pass validation (an unknown parameter, a text that is blank, longer than 100 characters or holds a NUL character, a limit outside 1 to 50)"),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});

export const listBookmarkShares = defineOperation({
  method: "get",
  path: "/api/v1/bookmarks/{id}/shares",
  operationId: "listBookmarkShares",
  tag: "sharing",
  summary: "List the shares of a bookmark",
  auth: "member",
  rate: "read",
  request: { params: BookmarkSharesParamsSchema },
  responses: {
    200: jsonResponse("The shares of the bookmark and the size of the audience they make. Only the owner of the bookmark reads them", BookmarkShareListSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    403: problemResponse(`${READ_REFUSED}${SHARED_WITH_CALLER}`),
    404: problemResponse(NO_BOOKMARK),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});

export const createBookmarkShare = defineOperation({
  method: "post",
  path: "/api/v1/bookmarks/{id}/shares",
  operationId: "createBookmarkShare",
  tag: "sharing",
  summary: "Share a bookmark with a member or a team",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: BookmarkSharesParamsSchema, body: CreateBookmarkShareRequestSchema },
  responses: {
    200: jsonResponse("The bookmark was shared with this target already: the share that exists, with nothing written", BookmarkShareSchema),
    201: jsonResponse("The bookmark is shared with the target; the audit log records share.granted", BookmarkShareSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    403: problemResponse(`${WRITE_REFUSED}${SHARED_WITH_CALLER}`),
    404: problemResponse(`${NO_BOOKMARK}, or the bookmark is plan-archived`),
    422: problemResponse(
      "The identifier or the body did not pass validation: no target or two, a field the operation does not declare, the caller as the member (validation_failed on accountId, cannot_share_with_self), an account that is no current member of the workspace (unknown_member on accountId) or a team of no team of the workspace (unknown_team on teamId). Nothing is written",
    ),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});

export const deleteBookmarkShare = defineOperation({
  method: "delete",
  path: "/api/v1/bookmarks/{id}/shares/{shareId}",
  operationId: "deleteBookmarkShare",
  tag: "sharing",
  summary: "Revoke a share of a bookmark",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: BookmarkShareParamsSchema },
  responses: {
    204: emptyResponse("The share is revoked for good: the target can no longer read the bookmark through it. The audit log records share.revoked"),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    403: problemResponse(`${REVOKE_REFUSED}${SHARED_WITH_CALLER}`),
    404: problemResponse(
      `${NO_BOOKMARK}, or the bookmark has no share with this identifier: a share of another bookmark, one that never existed and one that was revoked before are answered alike, since a hard delete keeps no tombstone and a repeat is not answered 204`,
    ),
    422: problemResponse("The identifiers did not pass validation"),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});

export const listFolderShares = defineOperation({
  method: "get",
  path: "/api/v1/folders/{id}/shares",
  operationId: "listFolderShares",
  tag: "sharing",
  summary: "List the shares of a folder",
  auth: "member",
  rate: "read",
  request: { params: FolderSharesParamsSchema },
  responses: {
    200: jsonResponse("The shares of the folder and the size of the audience they make. Only the owner of the folder reads them", FolderShareListSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    403: problemResponse(`${READ_REFUSED}${SHARED_FOLDER_WITH_CALLER}`),
    404: problemResponse(NO_FOLDER),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});

export const createFolderShare = defineOperation({
  method: "post",
  path: "/api/v1/folders/{id}/shares",
  operationId: "createFolderShare",
  tag: "sharing",
  summary: "Share a folder with a member or a team",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: FolderSharesParamsSchema, body: CreateFolderShareRequestSchema },
  responses: {
    200: jsonResponse("The folder was shared with this target already: the share that exists, with nothing written", FolderShareSchema),
    201: jsonResponse("The folder, and every bookmark filed in it now or later, is readable by the target; the audit log records share.granted", FolderShareSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    403: problemResponse(`${WRITE_REFUSED}${SHARED_FOLDER_WITH_CALLER}`),
    404: problemResponse(NO_FOLDER),
    422: problemResponse(
      "The identifier or the body did not pass validation: no target or two, a field the operation does not declare, the caller as the member (validation_failed on accountId, cannot_share_with_self), an account that is no current member of the workspace (unknown_member on accountId) or a team of no team of the workspace (unknown_team on teamId). Nothing is written",
    ),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});

export const deleteFolderShare = defineOperation({
  method: "delete",
  path: "/api/v1/folders/{id}/shares/{shareId}",
  operationId: "deleteFolderShare",
  tag: "sharing",
  summary: "Revoke a share of a folder",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: FolderShareParamsSchema },
  responses: {
    204: emptyResponse("The share is revoked for good: the target can no longer read the folder, or the bookmarks in it, through it. The audit log records share.revoked"),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    403: problemResponse(`${REVOKE_REFUSED}${SHARED_FOLDER_WITH_CALLER}`),
    404: problemResponse(
      `${NO_FOLDER}, or the folder has no share with this identifier: a share of another folder, one that never existed and one that was revoked before are answered alike, since a hard delete keeps no tombstone and a repeat is not answered 204`,
    ),
    422: problemResponse("The identifiers did not pass validation"),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});
