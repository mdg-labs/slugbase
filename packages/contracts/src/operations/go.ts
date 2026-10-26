import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The go tag of doc 04 section 10.8: how a slug is resolved for a member and how a member picks one of several bookmarks (doc 02 sections 6.2 to 6.4, Q25).
// Both operations act in the workspace the request is bound to and name none (D11), in the `go` rate bucket. A slug is trimmed and lower-cased before it is
// judged, and one outside the grammar resolves to nothing. The candidates of a slug are the bookmarks of the workspace with that slug, forwarding on and not
// plan-archived that the caller can read: a bookmark of another member that is not shared with the caller, one of another workspace, one that does not forward
// and an archived one are never named, so a resolution cannot tell them from a slug nobody has (doc 10 T1, T2 and T12). The resolution names the bookmarks and
// never their address; the address is the answer of a choice, which also counts the use.

export const GO_RESOLUTIONS = ["none", "preferred", "single", "multiple"] as const;

export const GO_SHARED_VIA = ["direct", "team", "folder"] as const;

export const GoSlugRequestSchema = z.strictObject({
  slug: z
    .string()
    .describe("The slug to resolve. It is trimmed and lower-cased before it is judged; one that is empty or outside the grammar resolves to nothing, not to an error"),
});

export const GoCandidateSchema = z
  .strictObject({
    id: z.uuid().describe("The bookmark's identifier; the choice names it"),
    title: z.string().describe("The bookmark's title"),
    host: z.string().describe("The host of the bookmark's destination, never the whole address"),
    owner: z
      .strictObject({
        accountId: z.uuid().describe("The owner's account"),
        displayName: z.string().describe("The owner's display name, as a member of the workspace sees it"),
      })
      .nullable()
      .describe("Who owns a bookmark that is shared with the caller; null for the caller's own bookmark and for one whose owner has left the workspace"),
    sharedVia: z
      .enum(GO_SHARED_VIA)
      .nullable()
      .describe("How the bookmark is shared with the caller: directly, through a team or through a shared folder; null for the caller's own bookmark"),
  })
  .meta({ id: "GoCandidate" });

export const GoResolutionSchema = z
  .discriminatedUnion("result", [
    z.strictObject({ result: z.literal("none").describe("Nothing the caller can read has the slug in the workspace, or the slug is not one") }),
    z.strictObject({
      result: z.literal("preferred").describe("The caller remembered a bookmark for the slug and it is still a candidate"),
      bookmark: GoCandidateSchema,
    }),
    z.strictObject({
      result: z.literal("single").describe("The caller's own bookmark with the slug, or the one bookmark shared with the caller that has it"),
      bookmark: GoCandidateSchema,
    }),
    z.strictObject({
      result: z.literal("multiple").describe("Several bookmarks shared with the caller have the slug and the caller has none of their own: the caller chooses one"),
      candidates: z.array(GoCandidateSchema).min(2).describe("The candidates in the order of their titles, then their identifiers"),
    }),
  ])
  .meta({ id: "GoResolution" });

export const GoChooseRequestSchema = z.strictObject({
  slug: z.string().describe("The slug that was resolved, as the caller wrote it"),
  bookmarkId: z.uuid().describe("The bookmark to go to. It has to be a current candidate of the slug for the caller"),
  remember: z
    .boolean()
    .optional()
    .describe("Whether to remember the choice, so that the slug resolves to this bookmark from now on while it stays a candidate; the choice is not remembered when this is left out"),
});

export const GoDestinationSchema = z
  .strictObject({
    url: z.string().describe("The destination to go to: the bookmark's URL as stored, checked again to be an http or https URL"),
  })
  .meta({ id: "GoDestination" });

export const resolveSlug = defineOperation({
  method: "post",
  path: "/api/v1/go/resolve",
  operationId: "resolveSlug",
  tag: "go",
  summary: "Resolve a slug for the caller",
  auth: "member",
  rate: "go",
  scope: "write",
  request: { body: GoSlugRequestSchema },
  responses: {
    200: jsonResponse(
      "What the slug resolves to for the caller in the workspace, in the order of Q25: the bookmark the caller remembered for it if it is still a candidate (preferred), the caller's own bookmark (single), the one bookmark shared with the caller (single), several bookmarks shared with the caller (multiple), or none. A slug that nothing the caller can read has is none, whoever else has it and in whichever workspace; the answer names no address and counts no use",
      GoResolutionSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope): the resolution is a POST, so it takes the write scope though it writes nothing",
    ),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The body did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const chooseSlug = defineOperation({
  method: "post",
  path: "/api/v1/go/choose",
  operationId: "chooseSlug",
  tag: "go",
  summary: "Choose a bookmark of a slug and get its destination",
  auth: "member",
  rate: "go",
  scope: "write",
  request: { body: GoChooseRequestSchema },
  responses: {
    200: jsonResponse(
      "The destination of the chosen bookmark. The use is counted asynchronously, as the open of a bookmark is, and the choice is remembered for the slug when remember is true, replacing an earlier one",
      GoDestinationSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The slug has no such bookmark among its current candidates for the caller (slug_not_found): another member's bookmark that is not shared with the caller, a bookmark of another workspace, one that does not forward, a plan-archived one, one with another slug, an unknown identifier and a slug outside the grammar are answered alike, and nothing is remembered or counted; or the request acts in no workspace",
    ),
    422: problemResponse("The body did not pass validation, or the stored URL is not an http or https URL (url_not_allowed); nothing is remembered or counted"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
