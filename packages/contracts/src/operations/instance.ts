import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";
import { WorkspaceNameSchema } from "./workspaces.ts";

// The instance tag of doc 04 section 10.10: the operations of the CE instance admin. Every one of them declares
// the `instanceAdmin` policy, which admits a complete browser session of an account that holds the flag and has a
// second factor enrolled, and no API token (doc 04 sections 1.2 and 4.2, Q44, Q45). The operations are mounted on
// every deployment and answer `403 forbidden` to everyone when no account holds the flag.

const COUNT = z.int().min(0);

export const InstanceStatusSchema = z
  .strictObject({
    version: z.string().describe("The version of the running build"),
    migrations: z
      .strictObject({
        expected: COUNT.describe("The migrations this build ships, across every chain it composes"),
        applied: COUNT.describe("The migrations of those that the database has recorded"),
      })
      .describe("The migration level of the database"),
    ports: z
      .strictObject({
        mail: z.boolean().describe("Whether a mail adapter is configured"),
        ai: z.boolean().describe("Whether an AI adapter is configured"),
        errorReporting: z.boolean().describe("Whether server error reporting is configured"),
      })
      .describe("Which optional ports the deployment configures; never the configuration itself"),
    oidcProviders: z
      .array(
        z.strictObject({
          slug: z.string().describe("The provider's slug"),
          name: z.string().describe("The name the sign-in page shows"),
        }),
      )
      .describe("The OIDC providers that are enabled and answered discovery, by slug and name only"),
    signIn: z
      .strictObject({
        publicRegistration: z.boolean().describe("The value of PUBLIC_REGISTRATION in force, the composition's default when the operator left it unset"),
        emailVerificationRequired: z.boolean().describe("The value of EMAIL_VERIFICATION_REQUIRED in force, the composition's default when the operator left it unset"),
      })
      .describe("The registration settings in force"),
    counts: z
      .strictObject({
        accounts: COUNT.describe("Every account, disabled ones included"),
        workspaces: COUNT.describe("The workspaces that are not being deleted"),
        activeSessions: COUNT.describe("The complete sessions that have not expired"),
      })
      .describe("What the instance holds"),
    jobs: z
      .strictObject({
        queueDepth: COUNT.describe("Background jobs that are due and waiting for a worker"),
        failed: COUNT.describe("Background jobs that failed and are still on record"),
      })
      .describe("The health of the background jobs"),
  })
  .meta({ id: "InstanceStatus" });

export const getInstanceStatus = defineOperation({
  method: "get",
  path: "/api/v1/instance/status",
  operationId: "getInstanceStatus",
  tag: "instance",
  summary: "Read the status of the instance",
  auth: "instanceAdmin",
  rate: "read",
  responses: {
    200: jsonResponse(
      "The version and migration level, the configured ports, the detected OIDC providers, the registration settings, the counts and the health of the background jobs; never a credential, a URL with credentials or a secret",
      InstanceStatusSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The session is not an instance admin's, or the account has no second factor enrolled, or the credential is an API token"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

/** The longest instance display name, in characters. */
export const INSTANCE_DISPLAY_NAME_MAX_LENGTH = 100;

/** The longest sign-in notice, in characters (doc 02 section 11.3). */
export const INSTANCE_SIGN_IN_NOTICE_MAX_LENGTH = 500;

// PostgreSQL cannot store U+0000 in a text column; a value that holds one is refused here, as a field error, rather
// than failing inside the database.
const withoutNul = (value: string): boolean => !value.includes("\u0000");
const NUL_MESSAGE = "must not contain a NUL character";

const InstanceDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(INSTANCE_DISPLAY_NAME_MAX_LENGTH)
  .refine(withoutNul, { message: NUL_MESSAGE })
  .describe("The instance name the sign-in page shows, 1 to 100 characters; surrounding whitespace is removed and a name that is blank after that is refused");

const InstanceSignInNoticeSchema = z
  .string()
  .trim()
  .min(1)
  .max(INSTANCE_SIGN_IN_NOTICE_MAX_LENGTH)
  .refine(withoutNul, { message: NUL_MESSAGE })
  .describe("Plain text shown on the sign-in page, 1 to 500 characters; surrounding whitespace is removed and a notice that is blank after that is refused. It is shown as text, never as HTML");

export const InstanceSettingsSchema = z
  .strictObject({
    allowWorkspaceCreation: z
      .boolean()
      .nullable()
      .describe("Whether ordinary accounts may create workspaces; null while the setting is not set, when the default of the deployment applies"),
    displayName: z.string().nullable().describe("The instance name the sign-in page shows; null while it is not set"),
    signInNotice: z.string().nullable().describe("The plain-text notice the sign-in page shows; null while there is none"),
  })
  .meta({ id: "InstanceSettings" });

export const UpdateInstanceSettingsRequestSchema = z
  .strictObject({
    allowWorkspaceCreation: z.boolean().nullable().optional().describe("true or false overrides the deployment's default, null clears the setting so the default applies again"),
    displayName: InstanceDisplayNameSchema.nullable().optional().describe("The new name, or null to clear it"),
    signInNotice: InstanceSignInNoticeSchema.nullable().optional().describe("The new notice, or null to remove it"),
  })
  .refine((request) => Object.values<unknown>(request).some((value) => value !== undefined), { message: "name at least one setting to change" })
  .meta({ id: "UpdateInstanceSettingsRequest" });

export const getInstanceSettings = defineOperation({
  method: "get",
  path: "/api/v1/instance/settings",
  operationId: "getInstanceSettings",
  tag: "instance",
  summary: "Read the instance settings",
  auth: "instanceAdmin",
  rate: "read",
  responses: {
    200: jsonResponse("The settings as stored; a setting that was never set, or was cleared, is null", InstanceSettingsSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The session is not an instance admin's, or the account has no second factor enrolled, or the credential is an API token"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const updateInstanceSettings = defineOperation({
  method: "patch",
  path: "/api/v1/instance/settings",
  operationId: "updateInstanceSettings",
  tag: "instance",
  summary: "Change the instance settings",
  auth: "instanceAdmin",
  rate: "write",
  request: { body: UpdateInstanceSettingsRequestSchema },
  responses: {
    200: jsonResponse(
      "The settings after the change; a setting the request leaves out keeps its value. A stored allowWorkspaceCreation overrides the deployment's default from the next request on, and the change is written to the instance audit stream",
      InstanceSettingsSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the session is not an instance admin's, the account has no second factor enrolled, or the credential is an API token (forbidden). Nothing is written",
    ),
    422: problemResponse("The body did not pass validation: a field the operation does not declare, no setting at all, a name or a notice that is blank, longer than its limit or holds a NUL character, or a value of the wrong type"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const sendInstanceTestMail = defineOperation({
  method: "post",
  path: "/api/v1/instance/mail/test",
  operationId: "sendInstanceTestMail",
  tag: "instance",
  summary: "Send a test email to the caller",
  auth: "instanceAdmin",
  rate: "write",
  responses: {
    202: emptyResponse("A test message to the caller's address is queued for the background worker, and the action is written to the instance audit stream"),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the session is not an instance admin's, the account has no second factor enrolled, or the credential is an API token (forbidden). Nothing is queued",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("No mail adapter is configured (mail_unavailable), or the service is temporarily unavailable (unavailable). Nothing is queued"),
  },
});

export const InstanceWorkspaceOwnerSchema = z
  .strictObject({
    accountId: z.uuid().describe("The owner's account identifier"),
    displayName: z.string().describe("The owner's display name"),
    email: z.string().describe("The owner's email address"),
  })
  .meta({ id: "InstanceWorkspaceOwner" });

export const InstanceWorkspaceSchema = z
  .strictObject({
    id: z.uuid().describe("The workspace's identifier"),
    name: z.string().describe("The workspace's name"),
    owners: z.array(InstanceWorkspaceOwnerSchema).describe("The workspace's owners; empty while it waits for the first owner an invitation will bring"),
    memberCount: COUNT.describe("How many members the workspace has; 0 while it waits for its first owner"),
    createdAt: z.iso.datetime().describe("When the workspace was created, RFC 3339 UTC"),
  })
  .meta({ id: "InstanceWorkspace" });

export const InstanceWorkspaceListSchema = z
  .strictObject({
    items: z.array(InstanceWorkspaceSchema).describe("Every workspace that is not being deleted, newest first"),
  })
  .meta({ id: "InstanceWorkspaceList" });

export const CreateInstanceWorkspaceRequestSchema = z
  .strictObject({
    name: WorkspaceNameSchema,
    ownerAccountId: z.uuid().optional().describe("An account that exists and is not disabled, which becomes the workspace's owner. Give this or ownerEmail, and not both"),
    ownerEmail: z
      .email()
      .max(320)
      .optional()
      .describe("The address of the first owner: the workspace waits for it, with an owner invitation for this address. Give this or ownerAccountId, and not both"),
  })
  .refine((request) => (request.ownerAccountId === undefined) !== (request.ownerEmail === undefined), {
    message: "name either ownerAccountId or ownerEmail",
  })
  .meta({ id: "CreateInstanceWorkspaceRequest" });

export const InstanceOwnerInvitationSchema = z
  .strictObject({
    id: z.uuid().describe("The invitation's identifier"),
    email: z.string().describe("The address the invitation is for; only the account that holds it can accept"),
    expiresAt: z.iso.datetime().describe("When the invitation stops working, RFC 3339 UTC"),
    link: z.url().describe("The address the invited owner opens to accept: the application's origin and /invite/ followed by the token. Returned this once and never again"),
  })
  .meta({ id: "InstanceOwnerInvitation" });

export const InstanceWorkspaceCreatedSchema = z
  .strictObject({
    id: z.uuid().describe("The new workspace's identifier"),
    name: z.string().describe("The workspace's name"),
    ownerInvitation: InstanceOwnerInvitationSchema.nullable().describe("The owner invitation when ownerEmail was given; null when an account was made the owner"),
  })
  .meta({ id: "InstanceWorkspaceCreated" });

export const InstanceWorkspaceParamsSchema = z.strictObject({
  id: z.uuid().describe("The identifier of a workspace, as listed"),
});

export const InstanceWorkspaceMembershipSchema = z
  .strictObject({
    workspaceId: z.uuid().describe("The workspace the calling admin is now a member of"),
    role: z.literal("member").describe("The role the membership has: always member, whatever the admin may be elsewhere"),
  })
  .meta({ id: "InstanceWorkspaceMembership" });

export const listInstanceWorkspaces = defineOperation({
  method: "get",
  path: "/api/v1/instance/workspaces",
  operationId: "listInstanceWorkspaces",
  tag: "instance",
  summary: "List every workspace of the instance",
  auth: "instanceAdmin",
  rate: "read",
  responses: {
    200: jsonResponse(
      "Every workspace that is not being deleted, with its name, owners, member count and creation time, newest first; never a bookmark or other content, and no member who is not an owner. Reading the list is written to the instance audit stream",
      InstanceWorkspaceListSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The session is not an instance admin's, or the account has no second factor enrolled, or the credential is an API token"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const createInstanceWorkspace = defineOperation({
  method: "post",
  path: "/api/v1/instance/workspaces",
  operationId: "createInstanceWorkspace",
  tag: "instance",
  summary: "Create a workspace for an owner account or an owner invitation",
  auth: "instanceAdmin",
  rate: "write",
  request: { body: CreateInstanceWorkspaceRequestSchema },
  responses: {
    201: jsonResponse(
      "The workspace is created with the account as its owner, or, for an address, with no member and one pending owner invitation that expires in 7 days; the invitation's link is returned this once and is in no email, log or later response. The admin does not become a member, and the action is written to the instance audit stream",
      InstanceWorkspaceCreatedSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the session is not an instance admin's, the account has no second factor enrolled, or the credential is an API token (forbidden). Nothing is written",
    ),
    422: problemResponse(
      "The body did not pass validation: a field the operation does not declare, a name that is blank or longer than 64 characters, neither or both of ownerAccountId and ownerEmail, or an ownerAccountId that is no account or is disabled (unknown_account). Nothing is written",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const addInstanceAdminMembership = defineOperation({
  method: "post",
  path: "/api/v1/instance/workspaces/{id}/membership",
  operationId: "addInstanceAdminMembership",
  tag: "instance",
  summary: "Add the calling instance admin to a workspace as a member",
  auth: "instanceAdmin",
  rate: "write",
  reauth: true,
  request: { params: InstanceWorkspaceParamsSchema },
  responses: {
    201: jsonResponse(
      "The calling admin is a member of the workspace with the member role, and nothing more: the membership gives what any member has. It is written to the workspace's own audit log as member.instance_admin_joined, where its owners read it as distinct from an accepted invitation, and to the instance audit stream as instance.workspace_joined, and member.joined is announced, all in one transaction. The admin's session is not moved to the workspace",
      InstanceWorkspaceMembershipSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the session is not an instance admin's, the account has no second factor enrolled, or the credential is an API token (forbidden)",
    ),
    404: problemResponse("There is no workspace with that identifier, or it is being deleted"),
    409: problemResponse("The calling account is a member of the workspace already, with any role (already_member); nothing is written"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const deleteInstanceWorkspace = defineOperation({
  method: "delete",
  path: "/api/v1/instance/workspaces/{id}",
  operationId: "deleteInstanceWorkspace",
  tag: "instance",
  summary: "Delete a workspace",
  auth: "instanceAdmin",
  rate: "write",
  reauth: true,
  request: { params: InstanceWorkspaceParamsSchema },
  responses: {
    202: emptyResponse(
      "The workspace is marked as being deleted and the request is written to the instance audit stream, in one transaction. From that moment it is gone from its members' workspaces, their sessions act in another workspace or in none, and its API tokens are revoked; the same background job as DELETE /workspace then removes its rows in batches. The deletion cannot be undone",
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the session is not an instance admin's, the account has no second factor enrolled, or the credential is an API token (forbidden)",
    ),
    404: problemResponse("There is no workspace with that identifier, or it is already being deleted"),
    409: problemResponse(
      "A deployment extension refuses the deletion (billing_active: the workspace owns an active paid subscription, which is cancelled first); nothing is changed and no audit event is written",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable, or a deployment extension that is consulted before the deletion did not answer in time; nothing is changed"),
  },
});

export const InstanceAccountSchema = z
  .strictObject({
    id: z.uuid().describe("The account's identifier"),
    displayName: z.string().describe("The account's display name"),
    email: z.string().describe("The account's address"),
    emailVerified: z.boolean().describe("Whether the address was confirmed"),
    mfaEnabled: z.boolean().describe("Whether a second factor is enrolled and confirmed"),
    isInstanceAdmin: z.boolean().describe("Whether the account holds the instance-admin flag"),
    disabled: z.boolean().describe("Whether the account is disabled: it cannot sign in, it has no session and its API tokens are refused"),
    lastSignInAt: z.iso.datetime().nullable().describe("When a complete sign-in last happened, RFC 3339 UTC; null while the account never signed in"),
    workspaceCount: COUNT.describe("How many workspaces, not being deleted, the account is a member of"),
  })
  .meta({ id: "InstanceAccount" });

export const InstanceAccountListSchema = z
  .strictObject({
    items: z.array(InstanceAccountSchema).describe("Every account, oldest first"),
  })
  .meta({ id: "InstanceAccountList" });

export const InstanceAccountParamsSchema = z.strictObject({
  id: z.uuid().describe("The identifier of an account, as listed"),
});

export const UpdateInstanceAccountRequestSchema = z
  .strictObject({
    isInstanceAdmin: z.boolean().optional().describe("true grants the instance-admin flag, false clears it; the target's sessions are deleted when the flag changes"),
    disabled: z.boolean().optional().describe("true disables the account, false enables it again; disabling deletes the target's sessions and refuses its API tokens"),
    emailVerified: z
      .literal(true)
      .optional()
      .describe(
        "true marks the account's address verified; for an address nobody had verified it takes away what the registrant set up, as redeeming the verification link does: the password, sessions, second factor, API tokens and linked identities of the account go, and the owner gets in through a password-reset link or a provider; nothing marks an address unverified, so false is refused",
      ),
  })
  .refine((request) => request.isInstanceAdmin !== undefined || request.disabled !== undefined || request.emailVerified !== undefined, {
    message: "name at least one of isInstanceAdmin, disabled and emailVerified",
  })
  .meta({ id: "UpdateInstanceAccountRequest" });

export const listInstanceAccounts = defineOperation({
  method: "get",
  path: "/api/v1/instance/accounts",
  operationId: "listInstanceAccounts",
  tag: "instance",
  summary: "List every account of the instance",
  auth: "instanceAdmin",
  rate: "read",
  responses: {
    200: jsonResponse(
      "Every account, oldest first, with its name, address, whether the address was confirmed and a second factor is on, the instance-admin flag, whether it is disabled, its last sign-in and its workspace count; never a hash, a secret or the content of a workspace. Reading the list is written to the instance audit stream",
      InstanceAccountListSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse("The session is not an instance admin's, or the account has no second factor enrolled, or the credential is an API token"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const updateInstanceAccount = defineOperation({
  method: "patch",
  path: "/api/v1/instance/accounts/{id}",
  operationId: "updateInstanceAccount",
  tag: "instance",
  summary: "Grant or clear the instance-admin flag of an account, disable or enable it, or mark its address verified",
  auth: "instanceAdmin",
  rate: "write",
  reauth: true,
  request: { params: InstanceAccountParamsSchema, body: UpdateInstanceAccountRequestSchema },
  responses: {
    200: jsonResponse(
      "The account after the change; a field the request leaves out, or sets to the value the account already has, changes nothing. Granting or clearing the flag deletes every session of the account. Disabling it deletes every session, refuses its API tokens from the next request on and, where a mail adapter is configured, queues the email that tells it so; enabling it clears the state. Marking an address verified that was not (also for a disabled account) runs the clean-up redeeming the verification link runs, in the same transaction: the account's password is removed, its sessions, second factor and backup codes, API tokens, linked identities, and its unused password-reset, email-change and verification tokens are deleted, because whoever registered the address is not necessarily its owner; the owner then gets in through a password-reset link (issueInstanceAccountResetLink) or a provider. The calling admin's own account keeps its second factor and sessions. An address that was verified already is left as it is. Each change is written to the instance audit stream",
      InstanceAccountSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the session is not an instance admin's, the account has no second factor enrolled, the credential is an API token, or this deployment does not grant the instance-admin flag (forbidden). Nothing is written",
    ),
    404: problemResponse("There is no account with that identifier"),
    422: problemResponse(
      "The body did not pass validation: a field the operation does not declare, none of the three fields, a value of the wrong type or emailVerified set to anything but true; or the change would leave the instance without an enabled instance admin: clearing the flag of, or disabling, the last one is refused as validation_failed with the field code last_instance_admin on isInstanceAdmin or disabled. Nothing is written",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const InstanceAccountResetLinkSchema = z
  .strictObject({
    delivery: z
      .enum(["mail", "link"])
      .describe("`mail`: the reset email is queued for the account's address and no link is returned. `link`: no mail adapter is configured and the link is returned here"),
    link: z
      .string()
      .nullable()
      .describe("The reset link, valid for one hour and for one use, returned only when delivery is `link` and nowhere again; null when it was mailed"),
  })
  .meta({ id: "InstanceAccountResetLink" });

export const resetInstanceAccountMfa = defineOperation({
  method: "post",
  path: "/api/v1/instance/accounts/{id}/mfa-reset",
  operationId: "resetInstanceAccountMfa",
  tag: "instance",
  summary: "Reset the second factor of an account that lost it",
  auth: "instanceAdmin",
  rate: "write",
  reauth: true,
  request: { params: InstanceAccountParamsSchema },
  responses: {
    204: emptyResponse(
      "The account's second factor is off: its secret, activation and backup codes are cleared and never returned, every session of the account is deleted, the instance audit stream records instance.account_mfa_reset and, where a mail adapter is configured, the account is emailed that an administrator reset it, all in one transaction. The account then signs in with its password alone. An account with no confirmed second factor is left as it is: nothing is written, deleted or sent",
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the session is not an instance admin's, the account has no second factor enrolled, or the credential is an API token (forbidden)",
    ),
    404: problemResponse("There is no account with that identifier"),
    422: problemResponse(
      "The account is disabled (validation_failed with the field code account_disabled on id), or it is the calling admin's own, whose second factor is turned off with the second factor that disabling it asks for (validation_failed with the field code self on id). Nothing is written",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const issueInstanceAccountResetLink = defineOperation({
  method: "post",
  path: "/api/v1/instance/accounts/{id}/password-reset-link",
  operationId: "issueInstanceAccountResetLink",
  tag: "instance",
  summary: "Issue a one-hour password-reset link for an account",
  auth: "instanceAdmin",
  rate: "write",
  reauth: true,
  request: { params: InstanceAccountParamsSchema },
  responses: {
    200: jsonResponse(
      "A password-reset token that works once for one hour, replacing the account's earlier unused one, is issued and written to the instance audit stream as instance.account_reset_link_issued (naming the delivery, never the token). Where a mail adapter is configured the link is emailed to the account and none is returned (delivery mail, link null); otherwise, and for an account with no password and no linked provider identity, which the reset email is not sent to, it is returned here, once, as delivery link. Redeeming it is the ordinary password reset: every session of the account is deleted and, for an account with a second factor, the new session is partial until the code is given",
      InstanceAccountResetLinkSchema,
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, its second factor is not complete, or it has not re-authenticated within the last ten minutes (reauth_required)"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the session is not an instance admin's, the account has no second factor enrolled, or the credential is an API token (forbidden)",
    ),
    404: problemResponse("There is no account with that identifier"),
    422: problemResponse(
      "The account cannot use a reset link: it is disabled (account_disabled), its address was never verified (email_unverified: mark it verified or resend the verification email first) or it signs in through a provider only, with no password and a linked identity (no_password), each as validation_failed with that field code on id. Nothing is written or issued",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const resendInstanceAccountVerification = defineOperation({
  method: "post",
  path: "/api/v1/instance/accounts/{id}/verification-email",
  operationId: "resendInstanceAccountVerification",
  tag: "instance",
  summary: "Resend the verification email of an account",
  auth: "instanceAdmin",
  rate: "write",
  request: { params: InstanceAccountParamsSchema },
  responses: {
    202: emptyResponse(
      "The verification email is queued for the account's address, with a new link that replaces its earlier unused one, and the request is written to the instance audit stream as instance.account_verification_resent, in one transaction",
    ),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request), the session is not an instance admin's, the account has no second factor enrolled, or the credential is an API token (forbidden)",
    ),
    404: problemResponse("There is no account with that identifier"),
    422: problemResponse(
      "The account's address is verified already (already_verified) or the account is disabled (account_disabled), each as validation_failed with that field code on id. Nothing is written or queued",
    ),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("No mail adapter is configured (mail_unavailable), or the service is temporarily unavailable (unavailable). Nothing is queued"),
  },
});
