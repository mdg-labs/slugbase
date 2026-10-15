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

export const OidcProviderParamsSchema = z.strictObject({
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .describe("The slug of the provider, as GET /api/config lists it under signIn.oidc"),
});

export const OidcStartQuerySchema = z.strictObject({
  returnTo: z
    .string()
    .max(2048)
    .optional()
    .describe("Where the browser goes once signed in: a path of this application, such as /go/docs. Anything else is ignored and the browser goes to /"),
});

const OIDC_REDIRECT_HEADERS = {
  Location: {
    description: "Where the browser goes next: the provider's authorization endpoint, or /login?error=oidc_failed when the handshake cannot start",
    schema: z.string(),
  },
  "Set-Cookie": {
    description: "The pre-auth cookie that binds the handshake to this browser: HttpOnly, SameSite=Lax, Path=/, valid for 10 minutes, Secure and __Host- prefixed when the deployment is served over https; cleared when no handshake started",
    schema: z.string(),
  },
} as const;

export const startOidcSignIn = defineOperation({
  method: "get",
  path: "/api/v1/auth/oidc/{provider}/start",
  operationId: "startOidcSignIn",
  tag: "auth",
  summary: "Start signing in with an OIDC provider",
  auth: "anonymous",
  rate: "login",
  request: { params: OidcProviderParamsSchema, query: OidcStartQuerySchema },
  responses: {
    302: emptyResponse(
      "The browser is sent to the provider with a PKCE challenge (S256), a state and a nonce, and receives the pre-auth cookie. When the provider is unknown or unavailable the browser is sent to /login?error=oidc_failed instead, the same answer a failed callback gives",
      { headers: OIDC_REDIRECT_HEADERS },
    ),
    400: problemResponse("The request was malformed"),
    422: problemResponse("The path or the query did not pass validation"),
    429: rateLimitedResponse("Too many sign-in attempts from this address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const completeOidcSignIn = defineOperation({
  method: "get",
  path: "/api/v1/auth/oidc/{provider}/callback",
  operationId: "completeOidcSignIn",
  tag: "auth",
  summary: "Finish signing in with an OIDC provider",
  auth: "anonymous",
  rate: "login",
  // The query is the provider's: `code` and `state`, or `error`, and whatever else the provider appends (`iss`, `scope`,
  // `session_state`). The handler reads the two it needs and ignores the rest, because a callback is a redirect the
  // browser follows, never a request this application's own schema can close.
  request: { params: OidcProviderParamsSchema },
  responses: {
    302: emptyResponse(
      "The handshake is over and the browser is sent on. When the identity is linked to an account that can sign in, a new full session cookie is set and the browser goes to the returnTo of the start, a path of this application. For every other outcome (a missing, reused, expired or foreign state, a refusal by the provider, a token that fails validation, an identity nobody linked, a disabled account) no session is created and the browser goes to /login?error=oidc_failed, one answer that does not say which. The pre-auth cookie is cleared either way",
      {
        headers: {
          Location: { description: "A path of this application: the returnTo of the start, or /login?error=oidc_failed", schema: z.string() },
          "Set-Cookie": {
            description: "The session cookie of a successful sign-in, with the attributes of the password sign-in cookie, and the cleared pre-auth cookie; on a failure only the cleared pre-auth cookie",
            schema: z.string(),
          },
        },
      },
    ),
    400: problemResponse("The request was malformed"),
    422: problemResponse("The path did not pass validation"),
    429: rateLimitedResponse("Too many sign-in attempts from this address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
