import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The remembered go choices of doc 04 section 10.3 (doc 02 section 6.4, doc 05 section 2.6): the member's mapping from a slug to the bookmark they chose to always go to, in
// the workspace the request is bound to, which names none (D11). A preference is its member's own, so another member's choices and those of another workspace are never
// listed and never forgotten (doc 10 T1 and T2). Both operations take a token, `read` to list and `write` to forget.

/** The most choices a page returns (doc 04 section 6.1). */
export const GO_PREFERENCE_LIST_MAX_LIMIT = 100;

/** The page size when `limit` is left out (doc 04 section 6.1). */
export const GO_PREFERENCE_LIST_DEFAULT_LIMIT = 50;

/** The longest cursor a client may send back: the slug (64 characters), the signature and the encoding take about 150. */
export const GO_PREFERENCE_CURSOR_MAX_LENGTH = 512;

export const GoPreferenceSchema = z
  .strictObject({
    slug: z.string().describe("The slug the choice is for, in lower case"),
    bookmarkId: z.uuid().describe("The bookmark the slug goes to for the caller"),
    title: z.string().describe("The bookmark's title"),
    host: z.string().describe("The host of the bookmark's destination, never the whole address"),
    owner: z
      .strictObject({
        accountId: z.uuid().describe("The owner's account"),
        displayName: z.string().describe("The owner's display name, as a member of the workspace sees it"),
      })
      .nullable()
      .describe("Who owns a bookmark that belongs to another member; null for the caller's own bookmark and for one whose owner has left the workspace"),
  })
  .meta({ id: "GoPreference" });

export const GoPreferenceListSchema = z
  .strictObject({
    items: z.array(GoPreferenceSchema).describe("One page of the caller's remembered choices in the workspace, in the order of their slugs"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
  })
  .meta({ id: "GoPreferenceList" });

export const ListGoPreferencesQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(GO_PREFERENCE_LIST_MAX_LIMIT).default(GO_PREFERENCE_LIST_DEFAULT_LIMIT).describe("The most choices to return, at most 100"),
  cursor: z
    .string()
    .min(1)
    .max(GO_PREFERENCE_CURSOR_MAX_LENGTH)
    .optional()
    .describe("The `nextCursor` of the previous page. It is valid only for the account and workspace that received it; any other cursor is refused with 400"),
});

export const GoPreferenceParamsSchema = z.strictObject({
  slug: z.string().describe("The slug whose remembered choice is forgotten. It is trimmed and lower-cased before it is looked up; a slug outside the grammar has no choice"),
});

export const listGoPreferences = defineOperation({
  method: "get",
  path: "/api/v1/me/go-preferences",
  operationId: "listGoPreferences",
  tag: "me",
  summary: "List my remembered go choices",
  auth: "member",
  rate: "read",
  scope: "read",
  request: { query: ListGoPreferencesQuerySchema },
  responses: {
    200: jsonResponse(
      "One page of the caller's remembered choices in the workspace in the order of their slugs, each with the bookmark it names by identifier, title, host and owner and never its address. Only a choice whose bookmark still has the slug, forwards, is not plan-archived and is readable by the caller is listed: the choices the resolution would follow",
      GoPreferenceListSchema,
    ),
    400: problemResponse("The request was malformed, or the cursor is not one this account was issued for this workspace (bad_request)"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    422: problemResponse("The query did not pass validation (an unknown parameter, a limit outside 1 to 100)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const deleteGoPreference = defineOperation({
  method: "delete",
  path: "/api/v1/me/go-preferences/{slug}",
  operationId: "deleteGoPreference",
  tag: "me",
  summary: "Forget a remembered go choice",
  auth: "member",
  rate: "write",
  scope: "write",
  request: { params: GoPreferenceParamsSchema },
  responses: {
    204: emptyResponse("The caller's remembered choice for the slug in the workspace is deleted; the bookmark stays and the slug resolves as it did before the choice was made"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself (cross_site_request), or the credential is an API token that may only read (token_scope)"),
    404: problemResponse(
      "The caller has no remembered choice for the slug in the workspace: another member's choice, one of another workspace, a slug outside the grammar, one that was never remembered and one that was forgotten before are answered alike, since a hard delete keeps no tombstone and a repeat is not answered 204; or the request acts in no workspace",
    ),
    422: problemResponse("The slug did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
