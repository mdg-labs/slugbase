import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The me tag of doc 04 section 10.3: what the signed-in account does to itself.
// The session operations act on the caller's own sessions only; a session id of
// another account is answered like one that does not exist.

export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;

export const THEMES = ["light", "dark", "system"] as const;
/** The six accent presets of doc 03 (Q36): a name of the palette, never a free colour. Periwinkle is the default. */
export const ACCENT_PRESETS = ["periwinkle", "violet", "rose", "amber", "green", "teal"] as const;
export const BOOKMARK_VIEWS = ["grid", "table"] as const;
export const ANALYTICS_CONSENTS = ["unset", "granted", "denied"] as const;

const ThemeSchema = z.enum(THEMES).describe("The colour scheme the account chose; system follows the operating system");
const AccentSchema = z.enum(ACCENT_PRESETS).describe("The accent colour, one of the six preset names");
const DefaultViewSchema = z.enum(BOOKMARK_VIEWS).describe("How bookmark lists are shown unless a list says otherwise");
const AnalyticsConsentSchema = z
  .enum(ANALYTICS_CONSENTS)
  .describe("Whether the account agreed to product analytics; a choice is stored with the time it was made, and unset clears that time");

const OnboardingFlags = {
  browserSetupDone: z.boolean().describe("Whether the browser setup step of the Getting started checklist is done"),
  importDone: z.boolean().describe("Whether the import step of the Getting started checklist is done"),
  checklistDismissed: z.boolean().describe("Whether the Getting started checklist is dismissed"),
};

export const OnboardingSchema = z.strictObject(OnboardingFlags).meta({ id: "Onboarding" });

export const OnboardingChangesSchema = z
  .strictObject({
    browserSetupDone: OnboardingFlags.browserSetupDone.optional(),
    importDone: OnboardingFlags.importDone.optional(),
    checklistDismissed: OnboardingFlags.checklistDismissed.optional(),
  })
  .describe("The checklist keys to change; a key left out keeps its value")
  .meta({ id: "OnboardingChanges" });

export const MembershipSchema = z
  .strictObject({
    workspaceId: z.uuid().describe("The workspace's identifier"),
    name: z.string().describe("The workspace's name"),
    role: z.enum(WORKSPACE_ROLES).describe("The account's role in the workspace"),
  })
  .meta({ id: "Membership" });

/**
 * The display name rule of doc 02 section 2: the name with its surrounding whitespace removed, 1 to 100
 * characters. Zod counts a character as one code point, as PostgreSQL's length() does, and a parsed value
 * is the trimmed name that is stored.
 */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe("The name shown to other members, 1 to 100 characters; surrounding whitespace is removed and a name that is blank after that is refused");

export const AccountSchema = z
  .strictObject({
    id: z.uuid().describe("The account's identifier"),
    email: z.string().describe("The account's email address, as stored"),
    displayName: z.string().describe("The name shown to other members"),
    locale: z.enum(["en", "de"]).describe("The language of the account's emails and of the app unless the browser overrides it"),
    theme: ThemeSchema,
    accent: AccentSchema.nullable().describe("The accent colour, one of the six preset names; null when none was chosen, which shows the default"),
    defaultView: DefaultViewSchema,
    singleKeyShortcuts: z.boolean().describe("Whether single-key shortcuts are on; modifier shortcuts always work"),
    aiOptOut: z.boolean().describe("Whether the account opted out of AI features"),
    analyticsConsent: AnalyticsConsentSchema,
    onboarding: OnboardingSchema.describe("The stored state of the Getting started checklist"),
    emailVerified: z.boolean().describe("Whether the email address was verified"),
    hasPassword: z.boolean().describe("Whether the account can sign in with a password; false for an account that signs in through an identity provider only"),
  })
  .meta({ id: "Account" });

export const UpdateAccountRequestSchema = z
  .strictObject({
    displayName: DisplayNameSchema.optional(),
    locale: z.enum(["en", "de"]).optional().describe("The language of the account's emails and of the app unless the browser overrides it"),
    theme: ThemeSchema.optional(),
    accent: AccentSchema.optional(),
    defaultView: DefaultViewSchema.optional(),
    singleKeyShortcuts: z.boolean().optional().describe("Whether single-key shortcuts are on; modifier shortcuts always work"),
    aiOptOut: z.boolean().optional().describe("Whether the account opted out of AI features"),
    analyticsConsent: AnalyticsConsentSchema.optional(),
    onboarding: OnboardingChangesSchema.optional(),
  })
  .meta({ id: "UpdateAccountRequest" });

export const MeSchema = z
  .strictObject({
    account: AccountSchema,
    memberships: z.array(MembershipSchema).describe("The workspaces the account is a member of, without one being deleted"),
    activeWorkspaceId: z
      .uuid()
      .nullable()
      .describe("The workspace the request acts in: the session's active one, else the member's most recently active one, else null; an API token's is the workspace it is bound to"),
    clientErrorReportDsn: z
      .string()
      .optional()
      .describe("The public DSN a browser error reporter initialises with; present only for a session, and only when the deployment registers a source"),
  })
  .meta({ id: "Me" });

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
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
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
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
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
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const getMe = defineOperation({
  method: "get",
  path: "/api/v1/me",
  operationId: "getMe",
  tag: "me",
  summary: "Read the signed-in account",
  auth: "account",
  rate: "read",
  scope: "read",
  responses: {
    200: jsonResponse("The account with its memberships and active workspace; no hash and no secret", MeSchema),
    401: problemResponse("There is no valid credential, or the session's second factor is not complete"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const updateMe = defineOperation({
  method: "patch",
  path: "/api/v1/me",
  operationId: "updateMe",
  tag: "me",
  summary: "Change the signed-in account's profile and preferences",
  auth: "account",
  rate: "write",
  request: { body: UpdateAccountRequestSchema },
  responses: {
    200: jsonResponse("The account after the change; a field the request leaves out keeps its value", AccountSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself"),
    422: problemResponse("The body did not pass validation: an unknown field or onboarding key, a name that is empty or longer than 100 characters, or a value outside the one the field allows (a language other than en and de, an accent that is not a preset name)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const ReauthRequestSchema = z
  .strictObject({
    password: z.string().min(1).max(256).describe("The account's current password"),
  })
  .meta({ id: "ReauthRequest" });

export const ChangePasswordRequestSchema = z
  .strictObject({
    currentPassword: z.string().min(1).max(256).describe("The account's current password"),
    newPassword: z.string().describe("The new password, 12 to 256 characters and not on the breached list"),
  })
  .meta({ id: "ChangePasswordRequest" });

export const reauthenticate = defineOperation({
  method: "post",
  path: "/api/v1/me/reauth",
  operationId: "reauthenticate",
  tag: "me",
  summary: "Re-authenticate the session with the account's password",
  auth: "account",
  rate: "mfa",
  request: { body: ReauthRequestSchema },
  responses: {
    204: emptyResponse("The password is right; the session counts as re-authenticated for the next ten minutes"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete; or the password is wrong or the account has none, answered as reauth_required with the field in errors[] and the session unchanged"),
    403: problemResponse("The request did not come from the application itself"),
    422: problemResponse("The body did not pass validation"),
    429: rateLimitedResponse("Too many attempts; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const changePassword = defineOperation({
  method: "post",
  path: "/api/v1/me/password",
  operationId: "changePassword",
  tag: "me",
  summary: "Change the account's password",
  auth: "account",
  rate: "write",
  reauth: true,
  request: { body: ChangePasswordRequestSchema },
  responses: {
    204: emptyResponse("The password is changed and every other session of the account is deleted; the response carries the Set-Cookie header of the session's new token"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    422: problemResponse("The body did not pass validation; the new password is refused by the policy (weak_password); or the current password is wrong or the account has none, answered alike as validation_failed with the field in errors[] and nothing changed"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const MfaEnrollmentSchema = z
  .strictObject({
    secret: z.string().describe("The text key an authenticator app takes when it cannot scan the code: the secret in base32, shown only in this response"),
    otpauthUri: z.string().describe("The otpauth:// URI the QR code holds; it names the issuer, the account's email and the secret"),
    qrSvg: z.string().describe("The QR code of the URI as an SVG document, to be shown as an image and never inserted into the page as markup"),
  })
  .meta({ id: "MfaEnrollment" });

export const ConfirmMfaEnrollmentRequestSchema = z
  .strictObject({
    code: z.string().min(1).max(16).describe("The current six-digit code of the authenticator app; spaces between the digits are ignored"),
  })
  .meta({ id: "ConfirmMfaEnrollmentRequest" });

export const MfaBackupCodesSchema = z
  .strictObject({
    backupCodes: z.array(z.string()).length(10).describe("Ten single-use backup codes of ten characters each, shown only in this response"),
  })
  .meta({ id: "MfaBackupCodes" });

export const startMfaEnrollment = defineOperation({
  method: "post",
  path: "/api/v1/me/mfa/enrollment",
  operationId: "startMfaEnrollment",
  tag: "me",
  summary: "Start enrolling an authenticator app",
  auth: "account",
  rate: "write",
  reauth: true,
  responses: {
    200: jsonResponse("A new pending secret as a text key, an otpauth:// URI and a QR code; an earlier unconfirmed secret is replaced and sign-in is unchanged until a code is confirmed", MfaEnrollmentSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    422: problemResponse("The account's second factor is already on, answered as validation_failed"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const confirmMfaEnrollment = defineOperation({
  method: "post",
  path: "/api/v1/me/mfa/enrollment/confirm",
  operationId: "confirmMfaEnrollment",
  tag: "me",
  summary: "Confirm the authenticator app with a code and turn the second factor on",
  auth: "account",
  rate: "mfa",
  request: { body: ConfirmMfaEnrollmentRequestSchema },
  responses: {
    200: jsonResponse("The second factor is on; the backup codes are returned once and never again", MfaBackupCodesSchema, {
      headers: {
        "Set-Cookie": {
          description: "The session cookie of the session's new token, with the attributes of the sign-in cookie; the old token is refused from now on",
          schema: z.string(),
        },
      },
    }),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    422: problemResponse(
      "The code is wrong, outside the accepted window or already used (invalid_code, counted against the mfa limit); the body did not pass validation; or no enrolment is pending (validation_failed)",
    ),
    429: rateLimitedResponse("Too many attempts; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
