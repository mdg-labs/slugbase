import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse } from "./define.ts";

// The me tag of doc 04 section 10.3: what the signed-in account does to itself.
// The session operations act on the caller's own sessions only; a session id of
// another account is answered like one that does not exist.

export const SessionSchema = z
  .strictObject({
    id: z.uuid().describe("The session's identifier; it names the session to revoke and is not the cookie's value"),
    createdAt: z.iso.datetime().describe("When the session was created, RFC 3339 UTC"),
    lastSeenAt: z.iso.datetime().describe("When the session last made a request, RFC 3339 UTC; refreshed at most once a minute"),
    userAgentFamily: z
      .string()
      .nullable()
      .describe("The browser or client family the session was created from; null when the client sent no user agent"),
    ipPrefix: z
      .string()
      .nullable()
      .describe("The coarse network the session was created from (the first two IPv4 octets or the IPv6 /48); never a full address; null when unknown"),
    current: z.boolean().describe("Whether this is the session the request is made with"),
  })
  .meta({ id: "Session" });

export const SessionListSchema = z
  .strictObject({
    items: z.array(SessionSchema).describe("One page of the account's valid sessions, newest first"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
  })
  .meta({ id: "SessionList" });

export const SessionListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50).describe("The most sessions to return, at most 100"),
  cursor: z.string().min(1).max(512).optional().describe("The `nextCursor` of the previous page; valid only for the account that received it"),
});

export const SessionIdParamsSchema = z.strictObject({
  id: z.uuid().describe("The session's identifier, as listed"),
});

export const RevokeSessionsQuerySchema = z.strictObject({
  includeCurrent: z
    .enum(["true", "false"])
    .default("false")
    .describe("Also revoke the session the request is made with, which clears its cookie"),
});

export const listSessions = defineOperation({
  method: "get",
  path: "/api/v1/me/sessions",
  operationId: "listSessions",
  tag: "me",
  summary: "List the account's sessions",
  auth: "account",
  rate: "read",
  request: { query: SessionListQuerySchema },
  responses: {
    200: jsonResponse("One page of the account's valid sessions; no token hash and no full address", SessionListSchema),
    400: problemResponse("The request was malformed, or the cursor is not one this account was issued"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    422: problemResponse("The query did not pass validation"),
    429: problemResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const revokeSession = defineOperation({
  method: "delete",
  path: "/api/v1/me/sessions/{id}",
  operationId: "revokeSession",
  tag: "me",
  summary: "Revoke one of the account's sessions",
  auth: "account",
  rate: "write",
  request: { params: SessionIdParamsSchema },
  responses: {
    204: emptyResponse("The session is deleted and refused from its next request; the cookie is cleared when it was the current session"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself"),
    404: problemResponse("The account has no session with this identifier"),
    422: problemResponse("The identifier did not pass validation"),
    429: problemResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const revokeSessions = defineOperation({
  method: "delete",
  path: "/api/v1/me/sessions",
  operationId: "revokeSessions",
  tag: "me",
  summary: "Revoke the account's other sessions",
  auth: "account",
  rate: "write",
  request: { query: RevokeSessionsQuerySchema },
  responses: {
    204: emptyResponse("Every other session of the account is deleted, with includeCurrent the current one too, whose cookie is then cleared"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself"),
    422: problemResponse("The query did not pass validation"),
    429: problemResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
