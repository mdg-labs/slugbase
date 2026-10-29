import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { withoutNul } from "./text.ts";

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
export const DisplayNameSchema = withoutNul(z.string().trim().min(1).max(100))
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
    signinAlerts: z.boolean().describe("Whether an email is sent when a password sign-in comes from a device the account has not signed in from"),
    aiOptOut: z.boolean().describe("Whether the account opted out of AI features"),
    analyticsConsent: AnalyticsConsentSchema,
    onboarding: OnboardingSchema.describe("The stored state of the Getting started checklist"),
    emailVerified: z.boolean().describe("Whether the email address was verified"),
    hasPassword: z.boolean().describe("Whether the account can sign in with a password; false for an account that signs in through an identity provider only"),
    mfaEnabled: z.boolean().describe("Whether a second factor is on; false when it is off or an enrolment is only pending"),
    isInstanceAdmin: z
      .boolean()
      .describe("Whether the account holds the instance-admin flag, as of this request; always false for an API token, which the instance operations refuse"),
    pendingEmail: z.string().nullable().describe("The address an email change was requested for and not yet confirmed, as stored; null when no change is pending"),
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
    signinAlerts: z.boolean().optional().describe("Whether an email is sent when a password sign-in comes from a device the account has not signed in from"),
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
    422: problemResponse("The body did not pass validation: an unknown field or onboarding key, a name that is empty, longer than 100 characters or holds a NUL character, or a value outside the one the field allows (a language other than en and de, an accent that is not a preset name)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const ReauthRequestSchema = z
  .union([
    z.strictObject({ password: z.string().min(1).max(256).describe("The account's current password") }),
    z.strictObject({ code: z.string().min(1).max(16).describe("The current six-digit code of the authenticator app, for an account whose second factor is on; spaces between the digits are ignored") }),
  ])
  .meta({ id: "ReauthRequest" });

export const ChangePasswordRequestSchema = z
  .strictObject({
    currentPassword: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("The account's current password. Left out only to set the first password of an account that has none, which needs a re-authentication within the last ten minutes; an account that has a password is refused without it"),
    newPassword: z.string().describe("The new password, 12 to 256 characters and not on the breached list"),
  })
  .meta({ id: "ChangePasswordRequest" });

export const reauthenticate = defineOperation({
  method: "post",
  path: "/api/v1/me/reauth",
  operationId: "reauthenticate",
  tag: "me",
  summary: "Re-authenticate the session with the account's password or a code of its authenticator app",
  auth: "account",
  rate: "mfa",
  request: { body: ReauthRequestSchema },
  responses: {
    204: emptyResponse("The password or the code is right; the session counts as re-authenticated for the next ten minutes"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete; or the password is wrong or the account has none, answered as reauth_required with the field in errors[] and the session unchanged. An account without a password re-authenticates through its provider (GET /auth/oidc/{provider}/start with the reauth intent) or, when its second factor is on, with a code"),
    403: problemResponse("The request did not come from the application itself"),
    422: problemResponse(
      "The code is wrong, outside the accepted window or already used, or the account's second factor is not on (invalid_code, counted against the mfa limit and the session unchanged); or the body did not pass validation",
    ),
    429: rateLimitedResponse("Too many attempts; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const changePassword = defineOperation({
  method: "post",
  path: "/api/v1/me/password",
  operationId: "changePassword",
  tag: "me",
  summary: "Change the account's password, or set the first one",
  auth: "account",
  rate: "write",
  reauth: true,
  request: { body: ChangePasswordRequestSchema },
  responses: {
    204: emptyResponse("The password is changed, or the first one set, and every other session of the account is deleted; the response carries the Set-Cookie header of the session's new token"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    422: problemResponse("The body did not pass validation; the new password is refused by the policy (weak_password); or the current password is wrong, is missing although the account has a password, or is given although the account has none, answered alike as validation_failed with the field in errors[] and nothing changed"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const RequestEmailChangeRequestSchema = z
  .strictObject({
    email: z.email().max(320).describe("The email address the account is to move to; case does not matter"),
  })
  .meta({ id: "RequestEmailChangeRequest" });

export const ConfirmEmailChangeRequestSchema = z
  .strictObject({
    token: z.string().min(1).max(256).describe("The token of the confirmation link mailed to the new address, from the fragment of /email-change/confirm#token=…"),
  })
  .meta({ id: "ConfirmEmailChangeRequest" });

export const CancelEmailChangeRequestSchema = z
  .strictObject({
    token: z.string().min(1).max(256).describe("The token of the \"this wasn't me\" link mailed to the old address, from the fragment of /email-change/cancel#token=…"),
  })
  .meta({ id: "CancelEmailChangeRequest" });

export const requestEmailChange = defineOperation({
  method: "post",
  path: "/api/v1/me/email",
  operationId: "requestEmailChange",
  tag: "me",
  summary: "Ask to change the account's email address",
  auth: "account",
  rate: "reset",
  reauth: true,
  request: { body: RequestEmailChangeRequestSchema },
  responses: {
    202: emptyResponse(
      "The request was accepted. The answer is the same, with no body, whether the address is free, is the account's own or belongs to another account. The address is recorded as the pending one and the links of an earlier request stop working, except the \"this wasn't me\" link of a change that was already confirmed, which keeps working until it expires or until a link to an earlier address is used; the account's current address is sent the notice with the \"this wasn't me\" link, and the new address is sent the confirmation link, which opens /email-change/confirm#token=…, only when it is free, so nothing is sent to another account. Nothing is sent to an account whose address was never verified, and a deployment without mail sends nothing and answers alike. The email switches only when the confirmation link is redeemed (POST /me/email/confirm)",
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    422: problemResponse("The body did not pass validation"),
    429: rateLimitedResponse("Too many requests from this account, this address or for this new email address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const confirmEmailChange = defineOperation({
  method: "post",
  path: "/api/v1/me/email/confirm",
  operationId: "confirmEmailChange",
  tag: "me",
  summary: "Confirm the new email address with the token of the link mailed to it",
  auth: "anonymous",
  rate: "token_redeem",
  request: { body: ConfirmEmailChangeRequestSchema },
  responses: {
    204: emptyResponse("The token is redeemed, once, and the account's email is the address the link was mailed to. No session ends"),
    400: problemResponse("The request was malformed"),
    403: problemResponse("The request did not come from the application itself"),
    410: problemResponse(
      "The token is unknown, expired (1 hour), already used, replaced by a newer one, of another kind or of a change that was cancelled; or its account is disabled or was never verified; or the address belongs to another account by now; all of them answer alike (token_expired) and nothing is changed",
    ),
    422: problemResponse("The body did not pass validation"),
    429: rateLimitedResponse("Too many attempts from this address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const cancelEmailChange = defineOperation({
  method: "post",
  path: "/api/v1/me/email/cancel",
  operationId: "cancelEmailChange",
  tag: "me",
  summary: "Cancel an email change and sign out everywhere with the \"this wasn't me\" link",
  auth: "anonymous",
  rate: "token_redeem",
  request: { body: CancelEmailChangeRequestSchema },
  responses: {
    204: emptyResponse(
      "The token is redeemed, once. The pending change and its unused links are gone and every session of the account is deleted. It works after the change was confirmed too, also when the account has asked for or cancelled another change since: the address the change replaced is then the account's email again, still verified, and every session still ends; the links to addresses the account held later stop working, and a link to an earlier address does not; if another account holds that address by now, the account keeps its current address",
    ),
    400: problemResponse("The request was malformed"),
    403: problemResponse("The request did not come from the application itself"),
    410: problemResponse("The token is unknown, expired (1 hour), already used, replaced by a newer one, of another kind, cancelled with its change or of a disabled account; all of them answer alike (token_expired) and nothing is changed"),
    422: problemResponse("The body did not pass validation"),
    429: rateLimitedResponse("Too many attempts from this address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const cancelPendingEmailChange = defineOperation({
  method: "delete",
  path: "/api/v1/me/email/pending",
  operationId: "cancelPendingEmailChange",
  tag: "me",
  summary: "Cancel the account's pending email change",
  auth: "account",
  rate: "write",
  responses: {
    204: emptyResponse("The pending address is cleared and the links of the change stop working, whether or not a change was pending; the \"this wasn't me\" link of a change that was already confirmed keeps working until it expires or until a link to an earlier address is used; no session ends"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
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

export const RegenerateBackupCodesRequestSchema = z
  .strictObject({
    code: z.string().min(1).max(16).describe("The current six-digit code of the authenticator app; spaces between the digits are ignored. A backup code is not accepted here"),
  })
  .meta({ id: "RegenerateBackupCodesRequest" });

const DisableMfaPassword = z
  .string()
  .min(1)
  .max(256)
  .optional()
  .describe("The account's current password. Left out only by an account that has none, whose re-authentication within the last ten minutes stands in for it; an account that has a password is refused without it");

export const DisableMfaRequestSchema = z
  .union([
    z.strictObject({
      password: DisableMfaPassword,
      code: z.string().min(1).max(16).describe("The current six-digit code of the authenticator app; spaces between the digits are ignored"),
    }),
    z.strictObject({
      password: DisableMfaPassword,
      backupCode: z.string().min(1).max(32).describe("One of the account's unused backup codes, which may be written in lower case and grouped by spaces or hyphens"),
    }),
  ])
  .meta({ id: "DisableMfaRequest" });

export const regenerateMfaBackupCodes = defineOperation({
  method: "post",
  path: "/api/v1/me/mfa/backup-codes",
  operationId: "regenerateMfaBackupCodes",
  tag: "me",
  summary: "Replace the account's backup codes with ten new ones",
  auth: "account",
  rate: "mfa",
  reauth: true,
  request: { body: RegenerateBackupCodesRequestSchema },
  responses: {
    200: jsonResponse("The old set is invalid from now on, used and unused codes alike; the ten new codes are returned once and never again", MfaBackupCodesSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    422: problemResponse(
      "The code is wrong, outside the accepted window or already used (invalid_code, counted against the mfa limit; the old backup codes stay valid); the body did not pass validation; or the account's second factor is not on (validation_failed)",
    ),
    429: rateLimitedResponse("Too many attempts; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const disableMfa = defineOperation({
  method: "delete",
  path: "/api/v1/me/mfa",
  operationId: "disableMfa",
  tag: "me",
  summary: "Turn the second factor off",
  auth: "account",
  rate: "mfa",
  reauth: true,
  request: { body: DisableMfaRequestSchema },
  responses: {
    204: emptyResponse("The secret, the activation time and every backup code are deleted and the account signs in with its password alone; the response carries the Set-Cookie header of the session's new token"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    422: problemResponse(
      "The code or backup code is wrong, outside the accepted window or already used (invalid_code, counted against the mfa limit); the password is wrong, is missing although the account has one, or is given although the account has none (validation_failed with the field in errors[]); the body did not pass validation; or the account's second factor is not on (validation_failed). Nothing changes in any of these cases",
    ),
    429: rateLimitedResponse("Too many attempts; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const API_TOKEN_SCOPES = ["read", "read-write"] as const;
/** The lifetimes of a new token in days (Q47); null in a request means it never expires. */
export const API_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;

export const ApiTokenSchema = z
  .strictObject({
    id: z.uuid().describe("The token's identifier; it names the token to revoke and is not part of the secret"),
    name: z.string().describe("The name the token was given, unique among the account's tokens"),
    workspaceId: z.uuid().describe("The workspace the token is bound to; every request made with it acts in that workspace"),
    workspaceName: z.string().describe("The name of that workspace"),
    scope: z.enum(API_TOKEN_SCOPES).describe("What the token may do: read, or read and write"),
    prefix: z.string().describe("The first six characters of the secret after slb_, to tell tokens apart and to search for a leaked one; never enough to use it"),
    createdAt: z.iso.datetime().describe("When the token was created, RFC 3339 UTC"),
    lastUsedAt: z.iso.datetime().nullable().describe("When the token last authenticated a request, RFC 3339 UTC; null when it never has"),
    expiresAt: z.iso.datetime().nullable().describe("When the token stops working, RFC 3339 UTC; null when it never expires"),
  })
  .meta({ id: "ApiToken" });

export const ApiTokenListSchema = z
  .strictObject({
    items: z.array(ApiTokenSchema).describe("One page of the account's tokens that are not revoked, newest first, across every workspace; no hash and no secret"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
  })
  .meta({ id: "ApiTokenList" });

export const CreatedApiTokenSchema = ApiTokenSchema.extend({
  token: z.string().describe("The secret, slb_ followed by 43 characters; shown only in this response, and only its hash is kept"),
}).meta({ id: "CreatedApiToken" });

export const ApiTokenListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50).describe("The most tokens to return, at most 100"),
  cursor: z.string().min(1).max(512).optional().describe("The `nextCursor` of the previous page; valid only for the account that received it"),
});

export const CreateApiTokenRequestSchema = z
  .strictObject({
    name: withoutNul(z.string().trim().min(1).max(64)).describe("The token's name, 1 to 64 characters, unique among the account's tokens; surrounding whitespace is removed"),
    scope: z.enum(API_TOKEN_SCOPES).describe("What the token may do: read, or read and write"),
    expiresInDays: z
      .union([z.literal([...API_TOKEN_EXPIRY_DAYS]), z.null()])
      .default(90)
      .describe("Days until the token stops working: 30, 90 or 365; null for a token that never expires; 90 when left out"),
    workspaceId: z
      .uuid()
      .optional()
      .describe("The workspace to bind the token to, one the account is a member of; the workspace the request acts in when left out"),
  })
  .meta({ id: "CreateApiTokenRequest" });

export const ApiTokenIdParamsSchema = z.strictObject({
  id: z.uuid().describe("The token's identifier, as listed"),
});

export const listApiTokens = defineOperation({
  method: "get",
  path: "/api/v1/me/api-tokens",
  operationId: "listApiTokens",
  tag: "me",
  summary: "List the account's API tokens",
  auth: "account",
  rate: "read",
  request: { query: ApiTokenListQuerySchema },
  responses: {
    200: jsonResponse("One page of the account's tokens that are not revoked, across its workspaces; never a hash or a secret", ApiTokenListSchema),
    400: problemResponse("The request was malformed, or the cursor is not one this account was issued"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The credential is an API token"),
    422: problemResponse("The query did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const createApiToken = defineOperation({
  method: "post",
  path: "/api/v1/me/api-tokens",
  operationId: "createApiToken",
  tag: "me",
  summary: "Create an API token",
  auth: "account",
  rate: "token_create",
  reauth: true,
  request: { body: CreateApiTokenRequestSchema },
  responses: {
    201: jsonResponse("The token is created; its secret is in this response only and is never returned again", CreatedApiTokenSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    404: problemResponse("The account is not a member of the workspace named, or the request names none and acts in none"),
    409: problemResponse("The account already has a token with this name (name_taken)"),
    422: problemResponse(
      "The body did not pass validation (a name outside 1 to 64 characters or holding a NUL character, an unknown scope, an expiry other than 30, 90, 365 or null); or the account already has 10 tokens that are neither revoked nor expired (validation_failed with the field code api_token_limit_reached)",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const revokeApiToken = defineOperation({
  method: "delete",
  path: "/api/v1/me/api-tokens/{id}",
  operationId: "revokeApiToken",
  tag: "me",
  summary: "Revoke one of the account's API tokens",
  auth: "account",
  rate: "write",
  request: { params: ApiTokenIdParamsSchema },
  responses: {
    204: emptyResponse("The token is revoked and refused from its next request; a token that was revoked before is answered the same way until the retention purge removes its row, 30 days after the revocation or the token's expiry, whichever is first"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    404: problemResponse("The account has no token with this identifier, another account's included, or its row was removed by the retention purge"),
    422: problemResponse("The identifier did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const IdentitySchema = z
  .strictObject({
    id: z.uuid().describe("The identity's identifier; it names the identity to unlink and is not the provider's subject"),
    provider: z.string().describe("The slug of the provider, as GET /api/config lists it under signIn.oidc; a provider the operator has since removed is still listed"),
    emailAtLink: z.string().describe("The address the provider asserted when the identity was linked, for display; empty when it asserted none"),
    createdAt: z.iso.datetime().describe("When the identity was linked, RFC 3339 UTC"),
    lastUsedAt: z.iso.datetime().nullable().describe("When the identity last signed in or re-authenticated the account, RFC 3339 UTC; null when it never has"),
  })
  .meta({ id: "Identity" });

export const IdentityListSchema = z
  .strictObject({
    items: z.array(IdentitySchema).describe("One page of the account's linked identities, newest first; never the provider's subject"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
  })
  .meta({ id: "IdentityList" });

export const IdentityListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50).describe("The most identities to return, at most 100"),
  cursor: z.string().min(1).max(512).optional().describe("The `nextCursor` of the previous page; valid only for the account that received it"),
});

export const IdentityIdParamsSchema = z.strictObject({
  id: z.uuid().describe("The identity's identifier, as listed"),
});

export const listIdentities = defineOperation({
  method: "get",
  path: "/api/v1/me/identities",
  operationId: "listIdentities",
  tag: "me",
  summary: "List the identities linked to the account",
  auth: "account",
  rate: "read",
  request: { query: IdentityListQuerySchema },
  responses: {
    200: jsonResponse("One page of the account's linked identities, newest first; no subject of the provider", IdentityListSchema),
    400: problemResponse("The request was malformed, or the cursor is not one this account was issued"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The credential is an API token"),
    422: problemResponse("The query did not pass validation"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const unlinkIdentity = defineOperation({
  method: "delete",
  path: "/api/v1/me/identities/{id}",
  operationId: "unlinkIdentity",
  tag: "me",
  summary: "Unlink one of the account's identities",
  auth: "account",
  rate: "write",
  reauth: true,
  request: { params: IdentityIdParamsSchema },
  responses: {
    204: emptyResponse("The identity is unlinked and can no longer sign in the account; the account's sessions are unchanged"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    404: problemResponse("The account has no identity with this identifier, another account's included"),
    422: problemResponse(
      "The identifier did not pass validation; or the identity is the account's only way to sign in, because the account has no password and no other identity (validation_failed with the field code last_sign_in_method in errors[]). Nothing changes",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const DeleteAccountRequestSchema = z
  .strictObject({
    email: z.string().min(1).max(320).describe("The account's own email address, typed to confirm the deletion; case and surrounding space do not matter"),
  })
  .meta({ id: "DeleteAccountRequest" });

export const deleteMe = defineOperation({
  method: "delete",
  path: "/api/v1/me",
  operationId: "deleteMe",
  tag: "me",
  summary: "Delete the account",
  auth: "account",
  rate: "write",
  reauth: true,
  request: { body: DeleteAccountRequestSchema },
  responses: {
    204: emptyResponse(
      "The account is deleted, with its sessions (the response clears the session cookie), API tokens, identities, emailed tokens and backup codes. Every workspace where it was the only member is deleted with it, the way a deleted workspace is: it is hidden at once and a background job removes its rows. In every other workspace its membership ends and the bookmarks and folders it created stay with the workspace without an owner. The audit events it caused keep the name they carry and lose the reference to the account and the network they were made from. `account.deleted` is announced to the modules that own content. The deletion cannot be undone",
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse("The request did not come from the application itself, or the credential is an API token"),
    409: problemResponse(
      "The account is the only owner of a workspace that has other members (last_owner), and the problem document names each such workspace in its `workspaces` member as `{ id, name }`, so the owner can transfer the ownership or delete the workspace first; or a deployment extension refuses the deletion (billing_active), for the account or for a workspace that would be deleted with it. Nothing is changed in either case",
    ),
    422: problemResponse(
      "The body did not pass validation; the address typed is not the account's own (validation_failed with the field code email_mismatch in errors[]); or the account is the only instance admin, which would leave the instance without one (validation_failed with the field code last_instance_admin in errors[]). Nothing is changed",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable, or a deployment extension that is consulted before the deletion did not answer in time; nothing is changed"),
  },
});
