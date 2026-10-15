import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The auth tag of doc 04 section 10.2. The sign-in operations are anonymous (the
// credential is the request) and are called from the SPA, so they carry the
// cross-site rules of section 5 like any other mutation.

export const LoginRequestSchema = z
  .strictObject({
    email: z.string().min(1).max(320).describe("The account's email address; case does not matter"),
    password: z.string().min(1).max(256).describe("The account's password"),
    remember: z.boolean().default(false).describe("Keep the session for 90 days of inactivity instead of 30"),
  })
  .meta({ id: "LoginRequest" });

export const LoginResultSchema = z
  .strictObject({
    next: z
      .enum(["done", "mfa"])
      .describe("`done`: the sign-in is complete. `mfa`: the password is right and the account's second factor is still to be given (POST /auth/mfa/verify); the session cookie is set either way, and a pending one expires after 5 minutes"),
  })
  .meta({ id: "LoginResult" });

export const VerifyMfaRequestSchema = z
  .union([
    z.strictObject({ code: z.string().min(1).max(16).describe("A code of the authenticator app: six digits, which may be grouped by a space") }),
    z.strictObject({ backupCode: z.string().min(1).max(32).describe("One of the account's unused backup codes, which may be written in lower case and grouped by spaces or hyphens") }),
  ])
  .meta({ id: "VerifyMfaRequest" });

export const VerifyMfaResultSchema = z
  .strictObject({
    next: z.literal("done").describe("The sign-in is complete and the session cookie holds the new token"),
  })
  .meta({ id: "VerifyMfaResult" });

export const login = defineOperation({
  method: "post",
  path: "/api/v1/auth/login",
  operationId: "login",
  tag: "auth",
  summary: "Sign in with an email address and a password",
  auth: "anonymous",
  rate: "login",
  request: { body: LoginRequestSchema },
  responses: {
    200: jsonResponse("The password is right; a new session cookie replaces any the request carried. The session is full when `next` is `done` and a partial one, good for POST /auth/mfa/verify, POST /auth/logout and GET /api/config only, when it is `mfa`", LoginResultSchema, {
      headers: {
        "Set-Cookie": {
          description: "The session cookie: HttpOnly, SameSite=Lax, Path=/, Secure and __Host- prefixed when the deployment is served over https",
          schema: z.string(),
        },
      },
    }),
    400: problemResponse("The request was malformed"),
    401: problemResponse("The email address or the password is wrong, or the account cannot sign in; all of them answer alike"),
    403: problemResponse("The request did not come from the application itself"),
    422: problemResponse("The body did not pass validation"),
    429: rateLimitedResponse("Too many sign-in attempts from this address or for this email address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const verifyMfa = defineOperation({
  method: "post",
  path: "/api/v1/auth/mfa/verify",
  operationId: "verifyMfa",
  tag: "auth",
  summary: "Complete a sign-in with a code of the authenticator app or a backup code",
  auth: "partial",
  rate: "mfa",
  request: { body: VerifyMfaRequestSchema },
  responses: {
    200: jsonResponse("The code is right: the partial session is now a full one under a new token, which the cookie carries; the old token is refused from now on", VerifyMfaResultSchema, {
      headers: {
        "Set-Cookie": {
          description: "The session cookie of the new token, with the attributes of the sign-in cookie; the choice to stay signed in is kept",
          schema: z.string(),
        },
      },
    }),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or it ended: it expired after 5 minutes or was revoked by its fifth refused code"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    422: problemResponse(
      "The code is wrong, outside the accepted window or already used, or the backup code is wrong or used (invalid_code, one answer for all of them and counted against the mfa limit; the fifth refusal ends the pending session); the body did not pass validation; or the session is not waiting for a second factor (validation_failed)",
    ),
    429: rateLimitedResponse("Too many attempts; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const logout = defineOperation({
  method: "post",
  path: "/api/v1/auth/logout",
  operationId: "logout",
  tag: "auth",
  summary: "End the current session",
  auth: "partial",
  rate: "write",
  responses: {
    204: emptyResponse("The session is deleted and its cookie cleared"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session to end"),
    403: problemResponse("The request did not come from the application itself"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
