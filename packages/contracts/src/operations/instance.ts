import { z } from "zod";
import { defineOperation, emptyResponse, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

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
