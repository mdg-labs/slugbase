import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { WORKSPACE_ROLES } from "./me.ts";

// The members operations of doc 04 section 10.5 that read the members of the workspace the request acts in,
// change a member's role and remove a member. They act in the workspace the request is bound to (the session's
// active one, or the one an API token is bound to) and name a member by account identifier, never a workspace.
// Removing a member and leaving the workspace (`leaveWorkspace`, in workspaces.ts) end a membership with the
// content choice of doc 02 section 3.6.

export const MemberTeamSchema = z
  .strictObject({
    id: z.uuid().describe("The team's identifier"),
    name: z.string().describe("The team's name"),
  })
  .meta({ id: "MemberTeam" });

export const MemberSchema = z
  .strictObject({
    accountId: z.uuid().describe("The member's account identifier"),
    displayName: z.string().describe("The member's display name"),
    email: z.string().describe("The member's email address"),
    role: z.enum(WORKSPACE_ROLES).describe("The member's role in the workspace"),
    joinedAt: z.iso.datetime().describe("When the account became a member of the workspace, RFC 3339 UTC"),
    lastActiveAt: z.iso.datetime().nullable().describe("When the member last acted in the workspace, RFC 3339 UTC; refreshed at most once a minute; null when it never has"),
    teams: z.array(MemberTeamSchema).describe("The teams of the workspace the member belongs to, ordered by name (ignoring case) and then identifier"),
  })
  .meta({ id: "Member" });

export const MemberListSchema = z
  .strictObject({
    items: z.array(MemberSchema).describe("One page of the workspace's members, in the order of their account identifiers"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
  })
  .meta({ id: "MemberList" });

export const MemberListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50).describe("The most members to return, at most 100"),
  cursor: z.string().min(1).max(512).optional().describe("The `nextCursor` of the previous page; valid only for the workspace that issued it"),
});

export const MemberAccountParamsSchema = z.strictObject({
  accountId: z.uuid().describe("The account identifier of a member of the workspace, as listed"),
});

export const UpdateMemberRequestSchema = z
  .strictObject({
    role: z.enum(WORKSPACE_ROLES).describe("The member's new role"),
  })
  .meta({ id: "UpdateMemberRequest" });

export const MEMBER_CONTENT_CHOICES = ["transfer", "delete"] as const;

export const EndMembershipRequestSchema = z
  .strictObject({
    content: z.enum(MEMBER_CONTENT_CHOICES).describe("What happens to the departing member's content: `transfer` it to the recipient, or `delete` it"),
    transferTo: z
      .uuid()
      .optional()
      .describe(
        "The account identifier of the member who receives the content; another current member of the workspace and not the one who departs. Left out, it is the account that removes the member, or the longest-standing owner when the member leaves on their own",
      ),
  })
  .meta({ id: "EndMembershipRequest" });

export const MembershipEndedSchema = z
  .strictObject({
    content: z.enum(MEMBER_CONTENT_CHOICES).describe("The content choice recorded with the departure; the modules that own content apply it when they handle `member.left`, which is delivered after the call answers"),
    transferTo: z.uuid().describe("The account identifier of the recipient, resolved from the request or its default; the content goes to it when the choice is `transfer`"),
  })
  .meta({ id: "MembershipEnded" });

export const listMembers = defineOperation({
  method: "get",
  path: "/api/v1/members",
  operationId: "listMembers",
  tag: "members",
  summary: "List the active workspace's members",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: MemberListQuerySchema },
  responses: {
    200: jsonResponse("One page of the workspace's members, each with the account's display name and email address and nothing else of the account, and the teams of the workspace it belongs to", MemberListSchema),
    400: problemResponse("The request was malformed, or the cursor is not one this workspace issued"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const updateMember = defineOperation({
  method: "patch",
  path: "/api/v1/members/{accountId}",
  operationId: "updateMember",
  tag: "members",
  summary: "Change a member's role",
  auth: "admin",
  rate: "write",
  request: { params: MemberAccountParamsSchema, body: UpdateMemberRequestSchema },
  responses: {
    200: jsonResponse(
      "The member with the role it now has, or the role it already had when the request names that. When the member is the caller the response carries the Set-Cookie header of the session's new token",
      MemberSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, the caller is a member and not an admin or owner of the workspace, or the caller is an admin and the change promotes to owner or touches an owner (forbidden)",
    ),
    404: problemResponse("The request acts in no workspace, or the account is not a member of it"),
    409: problemResponse("The change would leave the workspace without an owner (last_owner); nothing is written"),
    422: problemResponse("The identifier or the body did not pass validation (a role other than owner, admin or member, or a field the operation does not declare)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const removeMember = defineOperation({
  method: "delete",
  path: "/api/v1/members/{accountId}",
  operationId: "removeMember",
  tag: "members",
  summary: "Remove a member",
  auth: "admin",
  rate: "write",
  request: { params: MemberAccountParamsSchema, body: EndMembershipRequestSchema },
  responses: {
    200: jsonResponse(
      "The membership is ended at once and the recipient the request resolved to is returned. The content choice is queued with `member.left` and applied by the modules that own content once it is delivered after the call answers, not before. The member's sessions act in another workspace, or in none, from their next request and the API tokens bound to the workspace are dead",
      MembershipEndedSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the credential is an API token, the caller is a member and not an admin or owner of the workspace, or the caller is an admin and the member is an owner (forbidden)",
    ),
    404: problemResponse("The request acts in no workspace, or the account is not a member of it, or `transferTo` names an account that is not (the errors name transferTo)"),
    409: problemResponse("The member is the last owner of the workspace (last_owner); nothing is written"),
    422: problemResponse("The identifier or the body did not pass validation, or `transferTo` names the member who is removed (the errors name transferTo)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
