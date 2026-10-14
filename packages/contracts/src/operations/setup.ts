import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse } from "./define.ts";

// The first-run operations of doc 04 section 10.2 (community edition, doc 02
// section 2.2). Both are anonymous: setup runs before any account exists, so the
// credential is possession of the deployment, shown by the one-time setup token
// the server prints to its log. They are called from the SPA, so they carry the
// cross-site rules of section 5 like any other mutation (Q5).

export const SetupStatusSchema = z
  .strictObject({
    setupRequired: z.boolean().describe("Whether first-run setup is pending: the instance has no account, has not completed setup and has setup turned on"),
  })
  .meta({ id: "SetupStatus" });

export const SetupRequestSchema = z
  .strictObject({
    setupToken: z
      .string()
      .max(256)
      .optional()
      .describe("The setup token printed to the server log at the latest server start (an earlier one stops working); required when the deployment requires one"),
    displayName: z.string().min(1).max(100).describe("The first account's display name"),
    email: z.email().max(320).describe("The first account's email address"),
    password: z.string().describe("The first account's password, 12 to 256 characters"),
    workspaceName: z.string().min(1).max(64).describe("The name of the first workspace"),
  })
  .meta({ id: "SetupRequest" });

export const SetupResultSchema = z
  .strictObject({
    workspaceId: z.uuid().describe("The first workspace, which is the active one of the new session"),
  })
  .meta({ id: "SetupResult" });

export const getSetupStatus = defineOperation({
  method: "get",
  path: "/api/v1/setup/status",
  operationId: "getSetupStatus",
  tag: "setup",
  summary: "Whether first-run setup is pending",
  auth: "anonymous",
  rate: "public",
  responses: {
    200: jsonResponse("Whether the instance still waits for its first account", SetupStatusSchema),
    400: problemResponse("The request was malformed"),
    429: problemResponse("Too many requests from this address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});

export const completeSetup = defineOperation({
  method: "post",
  path: "/api/v1/setup",
  operationId: "completeSetup",
  tag: "setup",
  summary: "Create the first account, instance admin and owner of the first workspace, and sign it in",
  auth: "anonymous",
  rate: "setup",
  request: { body: SetupRequestSchema },
  responses: {
    201: jsonResponse("The first account and workspace exist and the new session cookie is set", SetupResultSchema, {
      headers: {
        "Set-Cookie": {
          description: "The session cookie: HttpOnly, SameSite=Lax, Path=/, Secure and __Host- prefixed when the deployment is served over https",
          schema: z.string(),
        },
      },
    }),
    400: problemResponse("The request was malformed"),
    403: problemResponse(
      "The request did not come from the application itself (cross_site_request); setup is already completed or turned off (setup_completed); or the setup token is missing or wrong (forbidden). Nothing is written",
    ),
    422: problemResponse("The body did not pass validation, or the password is outside 12 to 256 characters or is on the breached list (weak_password)"),
    429: problemResponse("Too many setup attempts from this address; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable"),
  },
});
