import { z } from "zod";
import { defineOperation, jsonResponse, problemResponse, rateLimitedResponse } from "./define.ts";

// The audit tag of doc 04 section 10.5: the workspace's audit log, read by its admins and owners (doc 02 section 10). The operation acts in
// the workspace the request is bound to and shows that workspace's events only; an event of the deployment, which belongs to no workspace,
// is in no answer. It carries the `audit.log` entitlement, which the server checks before the handler runs, and declares no token scope, so
// an API token never reads the log. An event is returned without the network it was made from.

/** The groups of the audit catalog an event is filtered by (`AUDIT_CATEGORIES` of `@slugbase/core`, which a test keeps equal to this list). */
export const AUDIT_EVENT_CATEGORIES = ["workspace", "member", "invitation", "team", "bookmark", "share"] as const;

/** The longest action name the log stores. */
const AUDIT_ACTION_MAX_LENGTH = 64;

/** The most action names one request filters by. */
export const AUDIT_ACTION_FILTER_MAX = 20;

const AuditActionNameSchema = z
  .string()
  .max(AUDIT_ACTION_MAX_LENGTH)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "a dotted action name such as member.removed");

const AuditEntityTypeSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "an entity type such as bookmark");

export const AUDIT_ACTOR_TYPES = ["account", "api_token", "system"] as const;

export const AuditEventActorSchema = z
  .strictObject({
    type: z.enum(AUDIT_ACTOR_TYPES).describe("Who made the change: an account, an API token of an account, or the system"),
    accountId: z
      .uuid()
      .nullable()
      .describe("The account that made the change; null for the system, and null for an account that has been deleted since, whose event stays and keeps its label"),
    label: z.string().describe("The actor's display name at the time of the change; it is never rewritten, whatever the account is called now"),
  })
  .meta({ id: "AuditEventActor" });

export const AuditEventEntitySchema = z
  .strictObject({
    type: z.string().describe("What kind of thing the change is about, such as workspace, member, team, bookmark or invitation"),
    id: z.uuid().describe("The identifier of the thing"),
  })
  .meta({ id: "AuditEventEntity" });

export const AuditEventSchema = z
  .strictObject({
    id: z.uuid().describe("The event's identifier"),
    createdAt: z.iso.datetime().describe("When the change was made, RFC 3339 UTC"),
    actor: AuditEventActorSchema,
    action: z.string().describe("The dotted name of the recorded action, such as member.removed"),
    category: z.enum(AUDIT_EVENT_CATEGORIES).nullable().describe("The group the action belongs to; null for an action the catalog no longer holds"),
    entity: AuditEventEntitySchema.nullable().describe("What the change is about; null for an event without a target"),
    metadata: z
      .record(z.string(), z.string())
      .describe("A few facts the action records, such as the old and the new name; the fields are fixed per action, never a secret, an address or a link"),
  })
  .meta({ id: "AuditEvent" });

export const AuditEventListSchema = z
  .strictObject({
    items: z.array(AuditEventSchema).describe("One page of the workspace's audit events, newest first, with the identifier as the tiebreak"),
    nextCursor: z.string().nullable().describe("Passed as `cursor` to get the next page; null on the last page"),
  })
  .meta({ id: "AuditEventList" });

export const AuditEventListQuerySchema = z.strictObject({
  actorAccountId: z.uuid().optional().describe("Lists the events made by this account. An account that made none in this workspace, or that is no account of it, lists nothing: an empty page, not an error"),
  action: z
    .union([AuditActionNameSchema, z.array(AuditActionNameSchema).max(AUDIT_ACTION_FILTER_MAX)])
    .optional()
    .describe("Lists the events of these actions, matched exactly on the dotted name: repeat the parameter, at most 20 times, for any of several. With `category`, only the actions that belong to that category"),
  category: z.enum(AUDIT_EVENT_CATEGORIES).optional().describe("Lists the events of the actions in this group"),
  entityType: AuditEntityTypeSchema.optional().describe("Lists the events about this kind of thing"),
  entityId: z.uuid().optional().describe("Lists the events about the thing with this identifier. One of another workspace, or an unknown one, lists nothing: an empty page, not an error"),
  from: z.iso.datetime().optional().describe("Lists the events made at or after this instant, RFC 3339 UTC"),
  to: z.iso.datetime().optional().describe("Lists the events made before this instant, RFC 3339 UTC"),
  limit: z.coerce.number().int().min(1).max(100).default(50).describe("The most events to return, at most 100"),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe("The `nextCursor` of the previous page. It is valid only with the filters it was issued for and only for the workspace that issued it; any other cursor is refused with 400"),
});

export const listAuditEvents = defineOperation({
  method: "get",
  path: "/api/v1/audit-events",
  operationId: "listAuditEvents",
  tag: "audit",
  summary: "List the active workspace's audit events",
  auth: "admin",
  rate: "read",
  entitlement: "audit.log",
  request: { query: AuditEventListQuerySchema },
  responses: {
    200: jsonResponse(
      "One page of the workspace's audit events, newest first, each with its actor (the label it had at the time), action, what it is about and a small metadata object, and never the network the change was made from. Events of the deployment are not in the log of any workspace",
      AuditEventListSchema,
    ),
    400: problemResponse("The request was malformed, or the cursor is not one this workspace issued for these filters"),
    401: problemResponse("There is no session, or its second factor is not complete"),
    403: problemResponse(
      "The credential is an API token, the caller is a member and not an admin or owner of the workspace (forbidden), or the workspace does not hold the audit.log entitlement (entitlement_required)",
    ),
    404: problemResponse("The request acts in no workspace"),
    422: problemResponse("The query did not pass validation (an identifier, an action name, a category or a time that is not one)"),
    429: rateLimitedResponse("Too many requests; Retry-After says when to try again"),
    503: problemResponse("The service is temporarily unavailable, or no entitlement source is configured"),
  },
});
