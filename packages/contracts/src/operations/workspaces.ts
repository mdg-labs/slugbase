import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { WORKSPACE_ROLES } from "./me.ts";

// The workspaces tag of doc 04 section 10.4, so far the account-level operations: listing the workspaces
// the signed-in account belongs to and creating one. Both act on the session's own account; neither names
// a workspace, and neither changes the active one (switching is its own operation).

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
      .describe("Whether the account can create a workspace: the deployment lets accounts create them and the account's email address is verified. The UI hides the action when it is false"),
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
    422: problemResponse("The body did not pass validation (a name that is blank or outside 1 to 64 characters, or a field the operation does not declare)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
