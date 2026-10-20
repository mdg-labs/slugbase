import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { DisplayNameSchema } from "./me.ts";

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

export const RegisterRequestSchema = z
  .strictObject({
    displayName: DisplayNameSchema.describe("The new account's display name; surrounding whitespace is removed"),
    email: z.email().max(320).describe("The new account's email address; case does not matter"),
    password: z.string().describe("The new account's password, 12 to 256 characters"),
  })
  .meta({ id: "RegisterRequest" });

export const ResendVerifyEmailRequestSchema = z
  .strictObject({
    email: z.email().max(320).describe("The email address the verification link was to be sent to; case does not matter"),
  })
  .meta({ id: "ResendVerifyEmailRequest" });

export const VerifyEmailRequestSchema = z
  .strictObject({
    token: z.string().min(1).max(256).describe("The token of the verification link, from the fragment of /verify-email#token=…"),
    password: z
      .string()
      .describe(
        "The password the account will sign in with, 12 to 256 characters. When the address was never verified it replaces the one the registration set, because whoever registered an address is not necessarily its owner; it is ignored for an account that is already verified",
      ),
  })
  .meta({ id: "VerifyEmailRequest" });

export const VerifyEmailResultSchema = z
  .strictObject({
    next: z
      .enum(["done", "mfa"])
      .describe("`done`: the address is verified and the account is signed in. `mfa`: the account's second factor is still to be given (POST /auth/mfa/verify); the session cookie is set either way, and a pending one expires after 5 minutes"),
  })
  .meta({ id: "VerifyEmailResult" });

export const ForgotPasswordRequestSchema = z
  .strictObject({
    email: z.email().max(320).describe("The email address of the account whose password is to be reset; case does not matter"),
  })
  .meta({ id: "ForgotPasswordRequest" });

export const ResetPasswordRequestSchema = z
  .strictObject({
    token: z.string().min(1).max(256).describe("The token of the reset link, from the fragment of /reset-password#token=…"),
    newPassword: z.string().describe("The account's new password, 12 to 256 characters"),
  })
  .meta({ id: "ResetPasswordRequest" });

export const ResetPasswordResultSchema = z
  .strictObject({
    next: z
      .enum(["done", "mfa"])
      .describe("`done`: the password is set and the account is signed in. `mfa`: the account's second factor is still to be given (POST /auth/mfa/verify); the session cookie is set either way, and a pending one expires after 5 minutes"),
  })
  .meta({ id: "ResetPasswordResult" });

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
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request); or the password is right but the deployment requires a verified email address and this account's was never verified (email_unverified), in which case no session is created and POST /auth/verify-email/resend sends the link again",
    ),
    422: problemResponse("The body did not pass validation"),
    429: rateLimitedResponse("Too many sign-in attempts from this address or for this email address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const register = defineOperation({
  method: "post",
  path: "/api/v1/auth/register",
  operationId: "register",
  tag: "auth",
  summary: "Register an account when public registration is open",
  auth: "anonymous",
  rate: "register",
  request: { body: RegisterRequestSchema },
  responses: {
    202: emptyResponse(
      "The request was accepted. The answer is the same, with no body, whether or not the email address already has an account and whatever the account's state: a new account is created unverified, and when the deployment can send mail it receives a verification email whose link opens /verify-email#token=…; an address that has an account is left untouched and nothing is sent to it",
    ),
    400: problemResponse("The request was malformed"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request); public registration is off (registration_closed); or the deployment's registration policy refused the address (registration_refused, one answer for every reason). Nothing is written",
    ),
    422: problemResponse("The body did not pass validation, or the password is outside 12 to 256 characters or is on the breached list (weak_password)"),
    429: rateLimitedResponse("Too many registrations from this address; Retry-After says when to try again"),
    503: problemResponse(
      "Email verification is required and no mail is configured (mail_unavailable), or the service is temporarily unavailable (unavailable). Nothing is written",
    ),
  },
});

export const verifyEmail = defineOperation({
  method: "post",
  path: "/api/v1/auth/verify-email",
  operationId: "verifyEmail",
  tag: "auth",
  summary: "Verify the email address of a registered account and sign it in",
  auth: "anonymous",
  rate: "token_redeem",
  request: { body: VerifyEmailRequestSchema },
  responses: {
    200: jsonResponse(
      "The token is redeemed, once. The address is verified, the personal workspace exists (one, however often the request is repeated), and a new session cookie replaces any the request carried. For an account whose address was never verified the password is the one in the request, and every session, the second factor with its backup codes, every API token and every linked identity the account had is gone. The session is full when `next` is `done` and a partial one, good for POST /auth/mfa/verify, POST /auth/logout and GET /api/config only, when it is `mfa`",
      VerifyEmailResultSchema,
      {
        headers: {
          "Set-Cookie": {
            description: "The session cookie: HttpOnly, SameSite=Lax, Path=/, Secure and __Host- prefixed when the deployment is served over https",
            schema: z.string(),
          },
        },
      },
    ),
    400: problemResponse("The request was malformed"),
    403: problemResponse("The request did not come from the application itself"),
    410: problemResponse("The token is unknown, expired (24 hours), already used or of another kind; all of them answer alike (token_expired), and nothing is changed"),
    422: problemResponse("The body did not pass validation, or the password is outside 12 to 256 characters or is on the breached list (weak_password). The token is not used"),
    429: rateLimitedResponse("Too many attempts from this address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const resendVerifyEmail = defineOperation({
  method: "post",
  path: "/api/v1/auth/verify-email/resend",
  operationId: "resendVerifyEmail",
  tag: "auth",
  summary: "Send the verification link of an unverified account again",
  auth: "anonymous",
  rate: "reset",
  request: { body: ResendVerifyEmailRequestSchema },
  responses: {
    202: emptyResponse(
      "The request was accepted. The answer is the same, with no body, whether the email address belongs to an unverified account, to a verified one or to no account: only an unverified account receives a new verification email, whose link opens /verify-email#token=… and replaces the account's earlier unused link, and nothing else about the account is changed or sent",
    ),
    400: problemResponse("The request was malformed"),
    403: problemResponse("The request did not come from the application itself"),
    422: problemResponse("The body did not pass validation"),
    429: rateLimitedResponse("Too many requests from this address or for this email address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const forgotPassword = defineOperation({
  method: "post",
  path: "/api/v1/auth/password/forgot",
  operationId: "forgotPassword",
  tag: "auth",
  summary: "Ask for a link to reset the password of an account",
  auth: "anonymous",
  rate: "reset",
  request: { body: ForgotPasswordRequestSchema },
  responses: {
    202: emptyResponse(
      "The request was accepted. The answer is the same, with no body, whether the email address belongs to an account with a password, to one without, or to none: only an account that has a password and whose address was verified receives a reset email, whose link opens /reset-password#token=… and replaces the account's earlier unused link; nothing else about the account is changed or sent. A deployment without mail sends nothing and answers alike (GET /api/config reports features.mail)",
    ),
    400: problemResponse("The request was malformed"),
    403: problemResponse("The request did not come from the application itself"),
    422: problemResponse("The body did not pass validation"),
    429: rateLimitedResponse("Too many requests from this address or for this email address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const resetPassword = defineOperation({
  method: "post",
  path: "/api/v1/auth/password/reset",
  operationId: "resetPassword",
  tag: "auth",
  summary: "Set a new password with the token of a reset link and sign in",
  auth: "anonymous",
  rate: "token_redeem",
  request: { body: ResetPasswordRequestSchema },
  responses: {
    200: jsonResponse(
      "The token is redeemed, once. The password is the one in the request, every session the account had is gone, and a new session cookie replaces any the request carried. The session is full when `next` is `done` and a partial one, good for POST /auth/mfa/verify, POST /auth/logout and GET /api/config only, when it is `mfa`, so the mailbox alone does not replace the second factor",
      ResetPasswordResultSchema,
      {
        headers: {
          "Set-Cookie": {
            description: "The session cookie: HttpOnly, SameSite=Lax, Path=/, Secure and __Host- prefixed when the deployment is served over https",
            schema: z.string(),
          },
        },
      },
    ),
    400: problemResponse("The request was malformed"),
    403: problemResponse("The request did not come from the application itself"),
    410: problemResponse(
      "The token is unknown, expired (1 hour), already used, replaced by a newer one or of another kind, or its account cannot reset a password (disabled, or its address never verified); all of them answer alike (token_expired). Neither the password nor any session changes; the token of a disabled account or of one whose address was never verified is used up",
    ),
    422: problemResponse("The body did not pass validation, or the password is outside 12 to 256 characters or is on the breached list (weak_password). The token is not used"),
    429: rateLimitedResponse("Too many attempts from this address; Retry-After says when to try again"),
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

export const OIDC_START_INTENTS = ["login", "link", "reauth", "invite"] as const;

export const OidcStartQuerySchema = z
  .strictObject({
    returnTo: z
      .string()
      .max(2048)
      .optional()
      .describe("Where the browser goes once the handshake is over: a path of this application, such as /go/docs. Anything else is ignored and the browser goes to /. The invite intent ignores it too and always ends on /"),
    intent: z
      .enum(OIDC_START_INTENTS)
      .default("login")
      .describe(
        "What the handshake is for. `login` (the default) signs in the account the identity is linked to. `link` adds the identity to the signed-in account and, because a linked identity outlives a password change and the end of every session, needs a session that re-authenticated within the last ten minutes: otherwise the start is answered `401 reauth_required` (re-authenticate with `POST /me/reauth` or the `reauth` intent, then start again), and the callback checks the same window. `reauth` proves the signed-in account's member at the provider, which counts as a re-authentication of the session for ten minutes. `link` and `reauth` need a complete session; all three of `link`, `reauth` and `invite` need the browser to report the request as coming from the application itself (Sec-Fetch-Site same-origin, or none for the address bar), and a request from another site or without that header is refused. `invite` accepts the invitation named by `invitation` through the provider, as the invited person; the session the acceptance makes replaces the one the browser carries. It counts against the token-redemption limits of the client address and, for a browser with a complete session, of its account",
      ),
    invitation: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("The token of the invitation link, from the path of /invite/<token>. Sent with the `invite` intent and with no other; the server keeps only its hash with the handshake"),
  })
  .refine((query) => (query.intent === "invite") === (query.invitation !== undefined), {
    path: ["invitation"],
    message: "The invitation token is sent with the invite intent and with no other",
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
      "The browser is sent to the provider with a PKCE challenge (S256), a state and a nonce, and receives the pre-auth cookie; for the reauth intent the provider is asked to ask for the credentials again. When the provider is unknown or unavailable, the link or reauth intent comes without a complete session, a link, reauth or invite start comes from another site or without a Sec-Fetch-Site header, or the invite intent carries a text that is not an invitation token, the browser is sent to /login?error=oidc_failed instead, the same answer a failed callback gives",
      { headers: OIDC_REDIRECT_HEADERS },
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("The link intent comes from a complete session that has not re-authenticated within the last ten minutes (reauth_required); nothing is stored. The login and reauth intents never answer it"),
    422: problemResponse("The path or the query did not pass validation"),
    429: rateLimitedResponse("Too many sign-in attempts from this address, or, for the invite intent, too many redemptions of invitation tokens from this address or by this account; Retry-After says when to try again"),
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
      "The handshake is over and the browser is sent on to the returnTo of the start, a path of this application. For the login intent, when the identity is linked to an account that can sign in, a new full session cookie is set; so it is for an identity nobody linked when the provider asserted its address as verified and either an enabled account that has verified that address gets the identity linked, or the provider allows accounts to be created, the address passes its allowed domains and the registration policy accepts it, and an account is created and the identity linked to it. For the invite intent, when the provider asserts the invited address, and no other, as verified, the identity is linked to the account it belongs to or to the enabled account that holds the invited address verified, or an account is created for the invited address (whatever the provider's auto-create setting says, because the invitation authorises it, and when the registration policy accepts it), the account becomes a member of the invitation's workspace with exactly the invited role, the invitation is accepted, and a new full session cookie is set that acts in that workspace. For the link intent the identity is added to the account that started the handshake, which must be the account of the browser's current session, and no session changes. For the reauth intent the browser's current session, which must be a session of the account that started the handshake and of an account the provider's identity is linked to, counts as re-authenticated from now. For every other outcome (a missing, reused, expired or foreign state, a refusal by the provider, a token that fails validation, an identity nobody linked whose address the provider did not assert as verified or that neither links nor creates an account, an invite intent whose provider address is not the invited one or is not verified or whose invitation is no longer pending, an address held by an unverified account, a disabled account, a registration the policy refuses, a link or reauth in a browser whose session is not the one that started it, a link whose session has not re-authenticated within the last ten minutes at the callback, an identity already linked to another account) nothing is changed and the browser goes to /login?error=oidc_failed, one answer that does not say which. The pre-auth cookie is cleared either way",
      {
        headers: {
          Location: { description: "A path of this application: the returnTo of the start, or /login?error=oidc_failed", schema: z.string() },
          "Set-Cookie": {
            description: "The session cookie of a successful sign-in, with the attributes of the password sign-in cookie, and the cleared pre-auth cookie; on a failure, and for the link and reauth intents, only the cleared pre-auth cookie",
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
