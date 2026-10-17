import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse } from "./define.ts";

export const HealthStatusSchema = z.strictObject({ status: z.literal("ok") }).meta({ id: "HealthStatus" });

export const ReadyStatusSchema = z
  .strictObject({
    database: z.enum(["ok", "unreachable"]).describe("Whether the database answers"),
    migrations: z.strictObject({
      expected: z.number().int().min(0).describe("Migrations the build ships"),
      applied: z.number().int().min(0).nullable().describe("Migrations applied to the database; null while it is unreachable"),
    }),
  })
  .meta({ id: "ReadyStatus" });

export const VersionInfoSchema = z
  .strictObject({
    name: z.string().describe("Product name"),
    version: z.string().describe("Release version"),
    commit: z.string().describe("Source revision of the build"),
    builtAt: z.string().describe("Build time, RFC 3339 UTC"),
  })
  .meta({ id: "VersionInfo" });

export const ApiConfigSchema = z
  .strictObject({
    apiVersion: z.literal("v1").describe("The API version the server speaks"),
    origin: z.url().describe("The origin the server is reached at, scheme and host without a path"),
    product: z.strictObject({
      name: z.string().describe("Product name"),
      version: z.string().describe("Release version"),
    }),
    locales: z.array(z.string()).min(1).describe("Locales the interface is available in"),
    defaultLocale: z.string().describe("Locale used when the visitor has no preference"),
    docsBaseUrl: z.url().describe("Base URL the help links point to; a link is the base followed by the documentation route"),
    features: z.strictObject({
      mail: z.boolean().describe("Whether a mail port is configured"),
      ai: z.boolean().describe("Whether an AI port is configured"),
    }),
    signIn: z
      .strictObject({
        registration: z
          .boolean()
          .describe(
            "Whether POST /auth/register takes registrations now: public registration is on (PUBLIC_REGISTRATION, with the default the deployment's composition supplies) and, when email verification is required, mail is configured",
          ),
        oidc: z
          .array(
            z.strictObject({
              slug: z.string().describe("The provider's slug, which names it in the sign-in routes"),
              name: z.string().describe("The name shown on the provider's button; the slug when the operator gave none"),
            }),
          )
          .describe("The OIDC providers the operator enabled that answered discovery, in the order of their slugs; never a secret or a provider URL"),
      })
      .optional()
      .describe("The sign-in methods beyond the password. This server always sends it"),
    setupRequired: z
      .boolean()
      .optional()
      .describe("Whether first-run setup is pending; the same answer as GET /api/v1/setup/status. This server always sends it"),
    setupTokenRequired: z
      .boolean()
      .optional()
      .describe("Whether the first account needs the one-time setup token; the same answer as GET /api/v1/setup/status, true only while setup is pending. A flag only, never the token. This server always sends it"),
  })
  .meta({ id: "ApiConfig" });

/** An OpenAPI 3.1 document; only the members every document has are named. */
export const OpenApiDocumentSchema = z
  .looseObject({
    openapi: z.string().describe("The OpenAPI version of the document"),
    info: z.looseObject({}),
    paths: z.looseObject({}),
  })
  .meta({ id: "OpenApiDocument" });

const malformed = problemResponse("The request was malformed");

export const getHealth = defineOperation({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  tag: "meta",
  summary: "Process liveness",
  auth: "anonymous",
  rate: "none",
  responses: {
    200: jsonResponse("The process is alive", HealthStatusSchema),
    400: malformed,
  },
});

export const getReady = defineOperation({
  method: "get",
  path: "/ready",
  operationId: "getReady",
  tag: "meta",
  summary: "Readiness of the database and migrations",
  auth: "anonymous",
  rate: "none",
  responses: {
    200: jsonResponse("The database is reachable and migrations are at the build's level", ReadyStatusSchema),
    400: malformed,
    503: jsonResponse("The database is unreachable or migrations are pending", ReadyStatusSchema),
  },
});

export const getVersion = defineOperation({
  method: "get",
  path: "/version",
  operationId: "getVersion",
  tag: "meta",
  summary: "Build information",
  auth: "anonymous",
  rate: "none",
  responses: {
    200: jsonResponse("Build information and nothing else", VersionInfoSchema),
    400: malformed,
  },
});

export const getApiConfig = defineOperation({
  method: "get",
  path: "/api/config",
  operationId: "getApiConfig",
  tag: "meta",
  summary: "Bootstrap configuration for the web app",
  auth: "anonymous",
  rate: "public",
  responses: {
    200: jsonResponse("The configuration the web app needs before sign-in", ApiConfigSchema, {
      headers: {
        "Cache-Control": {
          description: "Cacheable for 60 seconds; other API responses are no-store",
          schema: z.literal("public, max-age=60"),
        },
      },
    }),
    400: malformed,
  },
});

export const getOpenApiDocument = defineOperation({
  method: "get",
  path: "/api/v1/openapi.json",
  operationId: "getOpenApiDocument",
  tag: "meta",
  summary: "The OpenAPI document of this API",
  auth: "anonymous",
  rate: "public",
  responses: {
    200: jsonResponse("The committed OpenAPI 3.1 document, byte for byte", OpenApiDocumentSchema),
    400: malformed,
    404: problemResponse("The reference documents are disabled on this server"),
  },
});
