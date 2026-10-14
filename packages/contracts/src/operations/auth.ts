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
    next: z.literal("done").describe("The sign-in is complete and the session cookie is set"),
  })
  .meta({ id: "LoginResult" });

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
    200: jsonResponse("Signed in; a new session cookie replaces any the request carried", LoginResultSchema, {
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
