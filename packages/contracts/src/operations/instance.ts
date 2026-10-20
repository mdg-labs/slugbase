import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

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
