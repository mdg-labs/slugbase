import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The entitlements tag of doc 04 section 10.4 and doc 01 section 7.5. The operation reads what the composition's
// entitlement source grants the workspace the request acts in and the acting account, with the counters the
// meters and gates of the UI compare them with. It decides nothing: every enforcement point checks on the
// server, whatever the UI does with this answer.

const LimitSchema = z
  .union([z.int().min(0), z.literal("unlimited")])
  .describe("A count the holder may reach, or `unlimited` for no ceiling");

export const EntitlementSetSchema = z
  .strictObject({
    "bookmarks.max": LimitSchema.describe("How many bookmarks the workspace may hold, plan-archived ones not counted"),
    "seats.max": LimitSchema.describe("How many members the workspace may have; accepted invitations count, pending ones do not"),
    "workspaces.ownMax": LimitSchema.describe("How many workspaces the acting account may own; scoped to the account, not to the workspace"),
    "ai.suggestions": z.boolean().describe("Whether AI suggestions may be requested in the workspace"),
    "sharing.members": z.boolean().describe("Whether bookmarks and folders may be shared with individual members"),
    "sharing.teams": z.boolean().describe("Whether sharing with teams is available"),
    "members.invite": z.boolean().describe("Whether invitations may be created, listed, resent, linked and accepted"),
    "teams.manage": z.boolean().describe("Whether teams may be administered"),
    "audit.log": z.boolean().describe("Whether the audit log may be read; events are written whatever this says"),
  })
  .meta({ id: "EntitlementSet" });

export const EntitlementUsageSchema = z
  .strictObject({
    "bookmarks.used": z.int().min(0).describe("The workspace's bookmarks that are not plan-archived, as its bookmark_count says"),
    "seats.used": z.int().min(0).describe("The members of the workspace"),
    "workspaces.owned": z.int().min(0).describe("The workspaces the acting account owns, without one being deleted"),
  })
  .meta({ id: "EntitlementUsage" });

export const EntitlementsSchema = z
  .strictObject({
    entitlements: EntitlementSetSchema.describe("The value of every entitlement for the workspace the request acts in and the acting account"),
    usage: EntitlementUsageSchema.describe("What the limits are compared with"),
    upgradeAvailable: z.boolean().describe("Whether an upgrade path exists for the workspace; false on a deployment that sells no plans"),
  })
  .meta({ id: "Entitlements" });

export const getEntitlements = defineOperation({
  method: "get",
  path: "/api/v1/entitlements",
  operationId: "getEntitlements",
  tag: "entitlements",
  summary: "Read the active workspace's entitlements and usage",
  auth: "member",
  rate: "read",
  scope: "read",
  responses: {
    200: jsonResponse("The entitlements of the workspace the request acts in and of the acting account, the usage counters and whether an upgrade path exists", EntitlementsSchema),
    400: problemResponse("The request was malformed"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    404: problemResponse("The request acts in no workspace: the account has none, or the workspace is being deleted"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable, or no entitlement source is configured"),
  },
});
