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
