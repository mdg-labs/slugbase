import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { withoutNul } from "./text.ts";

// The teams tag of doc 04 section 10.5: the operations that list, create, read, change and delete the teams of the workspace the request is
// bound to, and replace a team's members. They act in the workspace of the request and name none (D11). A team is the workspace's and no
// member's (doc 02 section 4): every member lists the teams and reads their members, which the share picker needs, and an admin or owner changes
// them with the `teams.manage` entitlement. The changing operations declare no token scope, so a token never reaches them. A team of another
// workspace is answered 404, like one that does not exist (doc 04 section 2.4, doc 10 T1 and T2). Sharing with a team is another operation.

/** The longest team name, in characters (doc 02 section 4). */
export const TEAM_NAME_MAX_LENGTH = 64;

/** The longest team description, in characters (doc 02 section 4). */
export const TEAM_DESCRIPTION_MAX_LENGTH = 280;

/** The most accounts one request puts in a team. */
export const TEAM_MEMBERS_MAX = 1000;

/** The most teams a page returns (doc 04 section 6.1). */
export const TEAM_LIST_MAX_LIMIT = 100;

/** The page size when `limit` is left out (doc 04 section 6.1). */
export const TEAM_LIST_DEFAULT_LIMIT = 50;

/** The longest cursor a client may send back. The largest one the server issues carries a team name (64 characters, up to 6 bytes each once JSON-escaped), the identifier and the signature, as base64url: about 650 characters. */
export const TEAM_CURSOR_MAX_LENGTH = 1024;

const TeamNameSchema = withoutNul(z.string().trim().min(1).max(TEAM_NAME_MAX_LENGTH))
  .describe("The team's name, 1 to 64 characters after the whitespace around it is removed. It is stored as entered, in the case it is written in, and is unique in the workspace without regard to case");

const TeamDescriptionSchema = withoutNul(z.string().trim().max(TEAM_DESCRIPTION_MAX_LENGTH))
  .describe("The team's description, 0 to 280 characters after the whitespace around it is removed");

export const CreateTeamRequestSchema = z
  .strictObject({
    name: TeamNameSchema,
    description: TeamDescriptionSchema.optional().describe("The team's description, 0 to 280 characters; empty when left out"),
  })
  .meta({ id: "CreateTeamRequest" });

export const UpdateTeamRequestSchema = z
  .strictObject({
    name: TeamNameSchema.optional().describe("The new name, 1 to 64 characters after the whitespace around it is removed; unique in the workspace without regard to case. Left out, the name is left as it is"),
    description: TeamDescriptionSchema.optional().describe("The new description, 0 to 280 characters; an empty string clears it. Left out, the description is left as it is"),
  })
  .meta({ id: "UpdateTeamRequest" });

export const ReplaceTeamMembersRequestSchema = z
  .strictObject({
    accountIds: z
      .array(z.uuid())
      .max(TEAM_MEMBERS_MAX)
      .describe("The accounts that are the team's members afterwards, 0 to 1 000 identifiers; one named twice counts once. Every one must be a current member of the workspace, and an empty list empties the team"),
  })
  .meta({ id: "ReplaceTeamMembersRequest" });

export const TeamMemberSchema = z
  .strictObject({
    accountId: z.uuid().describe("The member's account identifier"),
    displayName: z.string().describe("The member's display name"),
    email: z.string().describe("The member's email address, which every co-member of the workspace sees"),
  })
  .meta({ id: "TeamMember" });

export const TeamSchema = z
  .strictObject({
    id: z.uuid().describe("The team's identifier"),
    name: z.string().describe("The team's name, in the case it was entered in"),
    description: z.string().describe("The team's description; empty when it has none"),
    memberCount: z.number().int().min(0).describe("How many members the team has"),
    version: z.number().int().min(1).describe("Moves by one with every change of the name, the description or the member set, with every invitation accepted into the workspace, whichever teams it names, and with a replacement of the member set that is refused for adding an account that joined the workspace after the version was written (a member who leaves the workspace takes its memberships without moving it); the ETag header of the single-team operations carries it and If-Match takes it back"),
    createdAt: z.iso.datetime().describe("When the team was created, RFC 3339 UTC"),
    updatedAt: z.iso.datetime().describe("When the team's version last moved, RFC 3339 UTC"),
  })
  .meta({ id: "Team" });

export const TeamWithMembersSchema = TeamSchema.extend({
  members: z.array(TeamMemberSchema).describe("The team's members, ordered by display name and then account identifier"),
}).meta({ id: "TeamWithMembers" });

export const ListTeamsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(TEAM_LIST_MAX_LIMIT).default(TEAM_LIST_DEFAULT_LIMIT).describe("The most teams to return, at most 100"),
  cursor: z
    .string()
    .min(1)
    .max(TEAM_CURSOR_MAX_LENGTH)
    .optional()
    .describe("The `nextCursor` of the previous page. It is valid only for the workspace that received it; any other cursor is refused with 400"),
});

export const TeamListSchema = z
  .strictObject({
    items: z.array(TeamSchema).describe("One page of the workspace's teams, ordered by name (ignoring case) and then identifier"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
  })
  .meta({ id: "TeamList" });

export const TeamParamsSchema = z.strictObject({
  id: z.uuid().describe("The team's identifier"),
});

/** The precondition of doc 04 section 2.4: the `ETag` of the version the caller read, as a quoted entity tag, or `*`. */
export const TeamIfMatchHeaderSchema = z.object({
  "If-Match": z
    .string()
    .optional()
    .describe('The ETag of the version the change is made against, for example "3". A team at another version answers 412 precondition_failed, and its version covers the name, the description and the member set. Optional, so a caller may leave it out; `*` matches any version'),
});

const TeamEntityTag = {
  ETag: { description: 'The team\'s version as an entity tag, for example "3"; the If-Match of the next change', schema: z.string() },
} as const;

const NO_SESSION = "There is no session, or its second factor is not complete";
const CHANGE_REFUSED =
  "The request did not come from the application itself (cross_site_request), the credential is an API token, the caller is a member and not an admin or owner of the workspace (forbidden), or the workspace does not hold the teams.manage entitlement (entitlement_required)";
const NO_WORKSPACE = "The request acts in no workspace: the account has none, or the workspace is being deleted";
const NO_TEAM = "The workspace the request acts in has no team with this identifier: a team of another workspace and one that never existed are answered alike";
const RATE_LIMITED = "Too many requests; Retry-After says when to try again";
const UNAVAILABLE = "The service is temporarily unavailable";

export const listTeams = defineOperation({
  method: "get",
  path: "/api/v1/teams",
  operationId: "listTeams",
  tag: "teams",
  summary: "List the teams",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: ListTeamsQuerySchema },
  responses: {
    200: jsonResponse("One page of the workspace's teams, each with its member count, and the cursor of the next page. Every member sees every team", TeamListSchema),
    400: problemResponse("The request was malformed, or the cursor is not one this workspace was issued (bad_request)"),
    401: problemResponse(NO_SESSION),
    404: problemResponse(NO_WORKSPACE),
    422: problemResponse("The query did not pass validation (an unknown parameter, a limit outside 1 to 100)"),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});

export const createTeam = defineOperation({
  method: "post",
  path: "/api/v1/teams",
  operationId: "createTeam",
  tag: "teams",
  summary: "Create a team",
  auth: "admin",
  rate: "write",
  entitlement: "teams.manage",
  request: { body: CreateTeamRequestSchema },
  responses: {
    201: jsonResponse("The team, with no members and version 1; the ETag header carries the version", TeamWithMembersSchema, { headers: TeamEntityTag }),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    403: problemResponse(CHANGE_REFUSED),
    404: problemResponse(NO_WORKSPACE),
    409: problemResponse("The workspace already has a team with this name, in any case (name_taken); nothing is written"),
    422: problemResponse("The body did not pass validation (a name that is blank, longer than 64 characters or holds a NUL character, a description longer than 280 or holding one, or a field the operation does not declare)"),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});

export const getTeam = defineOperation({
  method: "get",
  path: "/api/v1/teams/{id}",
  operationId: "getTeam",
  tag: "teams",
  summary: "Get a team with its members",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { params: TeamParamsSchema },
  responses: {
    200: jsonResponse("The team with its members. Every member sees every team", TeamWithMembersSchema, { headers: TeamEntityTag }),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    404: problemResponse(NO_TEAM),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});

export const updateTeam = defineOperation({
  method: "patch",
  path: "/api/v1/teams/{id}",
  operationId: "updateTeam",
  tag: "teams",
  summary: "Rename or describe a team",
  auth: "admin",
  rate: "write",
  entitlement: "teams.manage",
  request: { params: TeamParamsSchema, headers: TeamIfMatchHeaderSchema, body: UpdateTeamRequestSchema },
  responses: {
    200: jsonResponse(
      "The team after a JSON Merge Patch of its name and description. A change moves the version by one and the ETag is that of the new version; a patch that names the values the team has, and an empty one, write nothing and answer with the unchanged version",
      TeamWithMembersSchema,
      { headers: TeamEntityTag },
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    403: problemResponse(CHANGE_REFUSED),
    404: problemResponse(NO_TEAM),
    409: problemResponse("The workspace has another team with this name, in any case (name_taken); nothing is written"),
    412: problemResponse("If-Match names a version other than the team's current one (precondition_failed); the team is unchanged"),
    422: problemResponse("The identifier or the body did not pass validation (a name that is blank, longer than 64 characters or holds a NUL character, a description longer than 280 or holding one, or a field the operation does not declare). Nothing is written"),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});

export const deleteTeam = defineOperation({
  method: "delete",
  path: "/api/v1/teams/{id}",
  operationId: "deleteTeam",
  tag: "teams",
  summary: "Delete a team",
  auth: "admin",
  rate: "write",
  entitlement: "teams.manage",
  request: { params: TeamParamsSchema },
  responses: {
    204: emptyResponse("The team is deleted for good together with its memberships; the members stay members of the workspace"),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    403: problemResponse(CHANGE_REFUSED),
    404: problemResponse(
      "The workspace the request acts in has no team with this identifier: a team of another workspace, one that never existed and one that was deleted before are answered alike, since a hard delete keeps no tombstone and a repeat is not answered 204",
    ),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});

export const replaceTeamMembers = defineOperation({
  method: "put",
  path: "/api/v1/teams/{id}/members",
  operationId: "replaceTeamMembers",
  tag: "teams",
  summary: "Replace the members of a team",
  auth: "admin",
  rate: "write",
  entitlement: "teams.manage",
  request: { params: TeamParamsSchema, headers: TeamIfMatchHeaderSchema, body: ReplaceTeamMembersRequestSchema },
  responses: {
    200: jsonResponse(
      "The team with the members the request named, whether or not the set changed. Accounts outside the set are removed from the team and accounts in it are added. A set that differs from the team's moves the version by one and the ETag is that of the new version; the set the team has already writes nothing and answers with the unchanged version",
      TeamWithMembersSchema,
      { headers: TeamEntityTag },
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse(NO_SESSION),
    403: problemResponse(CHANGE_REFUSED),
    404: problemResponse(NO_TEAM),
    412: problemResponse("If-Match names a version other than the team's current one (precondition_failed), read under the team's row lock, or the replacement adds an account that joined the workspace after that version was written; the member set is unchanged, and in the second case only the version has moved, so a new read of the team carries the version to send"),
    422: problemResponse(
      "The identifier or the body did not pass validation: an account that is no current member of the workspace (validation_failed on accountIds, whichever workspace the account belongs to), more than 1 000 identifiers, or a field the operation does not declare. Nothing is written",
    ),
    429: rateLimitedResponse(RATE_LIMITED),
    503: problemResponse(UNAVAILABLE),
  },
});
