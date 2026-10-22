import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { WORKSPACE_ROLES } from "./me.ts";
import { EndMembershipRequestSchema, MemberSchema, MembershipEndedSchema } from "./members.ts";

// The workspaces tag of doc 04 section 10.4. The account-level operations list the workspaces the signed-in
// account belongs to, create one and switch the session's active one; they act on the session's own account,
// only the switch names a workspace, and listing and creating leave the active one alone. The operations on
// `/workspace` act in the workspace the request is bound to (the session's active one, or the one an API token
// is bound to) and name none: reading it, renaming it and reading and changing its settings.

/** The longest workspace name, in characters (doc 02 section 3.1). */
export const WORKSPACE_NAME_MAX_LENGTH = 64;

export const WorkspaceSummarySchema = z
  .strictObject({
    id: z.uuid().describe("The workspace's identifier"),
    name: z.string().describe("The workspace's name"),
    role: z.enum(WORKSPACE_ROLES).describe("The account's role in the workspace"),
    memberCount: z.number().int().min(1).describe("How many members the workspace has"),
  })
  .meta({ id: "WorkspaceSummary" });

export const WorkspaceListSchema = z
  .strictObject({
    items: z.array(WorkspaceSummarySchema).describe("The workspaces the account is a member of, without one being deleted, the most recently active first"),
    canCreate: z
      .boolean()
      .describe(
        "Whether the account can create a workspace: the deployment lets accounts create them, the account's email address is verified and the account owns fewer workspaces than its workspaces.ownMax entitlement allows. The UI hides the action, or shows the upgrade path in its place, when it is false",
      ),
  })
  .meta({ id: "WorkspaceList" });

/**
 * The name rule of doc 02 section 3.1: the name with its surrounding whitespace removed, 1 to 64 characters.
 * Zod counts a character as one code point, as PostgreSQL's length() does, and a parsed value is the trimmed
 * name that is stored.
 */
export const WorkspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(WORKSPACE_NAME_MAX_LENGTH)
  .describe("The workspace's name, 1 to 64 characters; surrounding whitespace is removed and a name that is blank after that is refused");

export const CreateWorkspaceRequestSchema = z.strictObject({ name: WorkspaceNameSchema }).meta({ id: "CreateWorkspaceRequest" });

export const WorkspaceSchema = z
  .strictObject({
    id: z.uuid().describe("The workspace's identifier"),
    name: z.string().describe("The workspace's name"),
    role: z.enum(WORKSPACE_ROLES).describe("The caller's role in the workspace"),
    memberCount: z.number().int().min(1).describe("How many members the workspace has"),
    createdAt: z.iso.datetime().describe("When the workspace was created, RFC 3339 UTC"),
    version: z.number().int().min(1).describe("Moves by one with every rename; the ETag header carries it and If-Match takes it back"),
  })
  .meta({ id: "Workspace" });

export const WorkspaceSettingsSchema = z
  .strictObject({
    aiEnabled: z.boolean().describe("Whether AI suggestions are on for the workspace; on until an admin turns them off"),
  })
  .meta({ id: "WorkspaceSettings" });

export const RenameWorkspaceRequestSchema = z.strictObject({ name: WorkspaceNameSchema }).meta({ id: "RenameWorkspaceRequest" });

export const UpdateWorkspaceSettingsRequestSchema = z
  .strictObject({
    aiEnabled: z.boolean().optional().describe("Turns AI suggestions on or off; a field that is left out is left as it is"),
  })
  .meta({ id: "UpdateWorkspaceSettingsRequest" });

/** The precondition of doc 04 section 2.4: the `ETag` of the version the caller read, as a quoted entity tag, or `*`. */
export const IfMatchHeaderSchema = z.object({
  "If-Match": z
    .string()
    .optional()
    .describe('The ETag of the version the change is made against, for example "3". A workspace at another version answers 412 precondition_failed. Optional; `*` matches any version'),
});

const EntityTagHeader = {
  ETag: { description: 'The workspace\'s version as an entity tag, for example "3"; the If-Match of the next change', schema: z.string() },
} as const;

export const SetActiveWorkspaceRequestSchema = z
  .strictObject({ workspaceId: z.uuid().describe("The workspace the session acts in from its next request on; one the account is a member of") })
  .meta({ id: "SetActiveWorkspaceRequest" });

export const TransferOwnershipRequestSchema = z
  .strictObject({
    accountId: z.uuid().describe("The account identifier of the member who becomes an owner; another member of the workspace, not the caller"),
    demoteSelf: z.boolean().describe("Whether the caller becomes an admin once the member is an owner; false leaves the caller an owner"),
  })
  .meta({ id: "TransferOwnershipRequest" });

export const listWorkspaces = defineOperation({
  method: "get",
  path: "/api/v1/workspaces",
  operationId: "listWorkspaces",
  tag: "workspaces",
  summary: "List the account's workspaces",
  auth: "account",
  rate: "read",
  responses: {
    200: jsonResponse("The account's workspaces, each with its role and member count, and whether the account can create another", WorkspaceListSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const createWorkspace = defineOperation({
  method: "post",
  path: "/api/v1/workspaces",
  operationId: "createWorkspace",
  tag: "workspaces",
  summary: "Create a workspace",
  auth: "account",
  rate: "write",
  request: { body: CreateWorkspaceRequestSchema },
  responses: {
    201: jsonResponse("The workspace is created with the account as its owner; the account's active workspace does not change", WorkspaceSummarySchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, the deployment does not let accounts create workspaces (forbidden), or the account's email address is not verified (email_unverified). Nothing is written",
    ),
    422: problemResponse(
      "The body did not pass validation (a name that is blank or outside 1 to 64 characters, or a field the operation does not declare), or the account already owns as many workspaces as its workspaces.ownMax entitlement allows (workspace_limit_reached; the problem carries limit, used and upgradeAvailable). Nothing is written",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable, or the entitlement source could not say how many workspaces the account may own"),
  },
});

export const setActiveWorkspace = defineOperation({
  method: "put",
  path: "/api/v1/session/active-workspace",
  operationId: "setActiveWorkspace",
  tag: "workspaces",
  summary: "Switch the session's active workspace",
  auth: "account",
  rate: "write",
  request: { body: SetActiveWorkspaceRequestSchema },
  responses: {
    204: emptyResponse("The session acts in the workspace from its next request on"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token, which cannot switch workspaces (forbidden)"),
    404: problemResponse(
      "The account is not a member of the workspace, or it does not exist or is being deleted; the answer is the same for each and the session keeps its active workspace",
    ),
    422: problemResponse("The body did not pass validation (a workspace identifier that is not a UUID, or a field the operation does not declare)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const getWorkspace = defineOperation({
  method: "get",
  path: "/api/v1/workspace",
  operationId: "getWorkspace",
  tag: "workspaces",
  summary: "Read the active workspace",
  auth: "member",
  rate: "read",
  scope: "read",
  responses: {
    200: jsonResponse("The workspace the request acts in, with the caller's role and the number of members", WorkspaceSchema, { headers: EntityTagHeader }),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const renameWorkspace = defineOperation({
  method: "patch",
  path: "/api/v1/workspace",
  operationId: "renameWorkspace",
  tag: "workspaces",
  summary: "Rename the active workspace",
  auth: "admin",
  rate: "write",
  request: { headers: IfMatchHeaderSchema, body: RenameWorkspaceRequestSchema },
  responses: {
    200: jsonResponse("The workspace under its new name, or under the name it already had when the request names that; the ETag is that of the new version", WorkspaceSchema, {
      headers: EntityTagHeader,
    }),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, or the caller is a member and not an admin or owner of the workspace (forbidden)",
    ),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    412: problemResponse("If-Match names a version other than the workspace's current one (precondition_failed); the name is unchanged"),
    422: problemResponse("The body did not pass validation (a name that is blank or outside 1 to 64 characters, or a field the operation does not declare)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const getWorkspaceSettings = defineOperation({
  method: "get",
  path: "/api/v1/workspace/settings",
  operationId: "getWorkspaceSettings",
  tag: "workspaces",
  summary: "Read the active workspace's settings",
  auth: "admin",
  rate: "read",
  responses: {
    200: jsonResponse("The settings of the workspace the request acts in", WorkspaceSettingsSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The credential is an API token, or the caller is a member and not an admin or owner of the workspace (forbidden)"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const updateWorkspaceSettings = defineOperation({
  method: "patch",
  path: "/api/v1/workspace/settings",
  operationId: "updateWorkspaceSettings",
  tag: "workspaces",
  summary: "Change the active workspace's settings",
  auth: "admin",
  rate: "write",
  request: { body: UpdateWorkspaceSettingsRequestSchema },
  responses: {
    200: jsonResponse("The settings after the change; a request that changes no value answers the settings as they are", WorkspaceSettingsSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, or the caller is a member and not an admin or owner of the workspace (forbidden)",
    ),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The body did not pass validation (a value of the wrong type, or a field the operation does not declare)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const leaveWorkspace = defineOperation({
  method: "post",
  path: "/api/v1/workspace/leave",
  operationId: "leaveWorkspace",
  tag: "workspaces",
  summary: "Leave the active workspace",
  auth: "member",
  rate: "write",
  request: { body: EndMembershipRequestSchema },
  responses: {
    200: jsonResponse(
      "The caller's membership is ended at once and the recipient the request resolved to is returned. The content choice is queued with `member.left` and applied by the modules that own content once it is delivered after the call answers, not before. The session acts in another workspace, or in none, from its next request",
      MembershipEndedSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted; or `transferTo` names an account that is not a member of it (the errors name transferTo)"),
    409: problemResponse("The caller is the last owner of the workspace (last_owner); nothing is written"),
    422: problemResponse("The body did not pass validation, or `transferTo` names the caller (the errors name transferTo)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const deleteWorkspace = defineOperation({
  method: "delete",
  path: "/api/v1/workspace",
  operationId: "deleteWorkspace",
  tag: "workspaces",
  summary: "Delete the active workspace",
  auth: "owner",
  rate: "write",
  reauth: true,
  responses: {
    202: emptyResponse(
      "The workspace is marked as being deleted and the request is recorded in its audit log, in one transaction. From that moment it is gone from the account's workspaces, its members' sessions act in another workspace or in none, and its API tokens are revoked; a background job then removes its rows in batches and announces `workspace.deleted` when the workspace row is gone. The deletion cannot be undone",
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), the credential is an API token, or the caller is not an owner of the workspace (forbidden)"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is already being deleted"),
    409: problemResponse(
      "A deployment extension refuses the deletion (billing_active: the workspace owns an active paid subscription, which is cancelled first); nothing is changed and no audit event is written",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable, or a deployment extension that is consulted before the deletion did not answer in time; nothing is changed"),
  },
});

export const transferWorkspaceOwnership = defineOperation({
  method: "post",
  path: "/api/v1/workspace/transfer-ownership",
  operationId: "transferWorkspaceOwnership",
  tag: "workspaces",
  summary: "Transfer the active workspace's ownership",
  auth: "owner",
  rate: "write",
  reauth: true,
  request: { body: TransferOwnershipRequestSchema },
  responses: {
    200: jsonResponse(
      "The member is an owner of the workspace; when the caller asked to step down, the caller is an admin in the same transaction and the response carries the Set-Cookie header of the session's new token. The member is told by email, in their language, when the call made them an owner. When the member already is an owner and the caller stays one, nothing changes and nothing is written",
      MemberSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), the credential is an API token, or the caller is not an owner of the workspace (forbidden)"),
    404: problemResponse("The request acts in no workspace, or the account is not a member of it, whichever workspace it belongs to"),
    409: problemResponse("The change would leave the workspace without an owner (last_owner); nothing is written"),
    422: problemResponse("The body did not pass validation (an identifier that is not a UUID, a `demoteSelf` that is not a boolean, or a field the operation does not declare), or `accountId` names the caller (the errors name accountId)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
