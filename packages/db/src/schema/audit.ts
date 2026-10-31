import { sql } from "drizzle-orm";
import { check, cidr, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounts.ts";
import { workspaces } from "./workspaces.ts";

// `audit_events` of doc 05 section 2.9: the log of a workspace's significant changes, written by the
// audit writer in the transaction of the change it records. Row-level security, the policies and the
// privileges of `slugbase_app` (INSERT and SELECT, never UPDATE or DELETE) live in
// src/sql/250-audit-events.sql, which Drizzle cannot express; only a system operation deletes a row
// (the retention purge, sys_retention_purge).
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid().primaryKey(),
    /** Null for a deployment-level event, which no tenant policy admits. */
    workspaceId: uuid().references(() => workspaces.id, { onDelete: "cascade" }),
    actorType: text().notNull(),
    /** The deletion of the account keeps the event and clears this. */
    actorAccountId: uuid().references(() => accounts.id, { onDelete: "set null" }),
    /** The display name at the time; never rewritten. */
    actorLabel: text().notNull(),
    /** The token an `api_token` actor used; no reference, so the event outlives the token's row. */
    actorTokenId: uuid(),
    /** A dotted name of the catalog in packages/core/src/audit. */
    action: text().notNull(),
    entityType: text(),
    entityId: uuid(),
    /** Validated against the catalog before the insert; never a secret. */
    metadata: jsonb().notNull().default({}),
    /** The coarse network of the request; never a precise address. */
    ipPrefix: cidr(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("audit_events_actor_type_check", sql`${table.actorType} IN ('account', 'api_token', 'system')`),
    check("audit_events_actor_label_check", sql`length(${table.actorLabel}) BETWEEN 1 AND 200`),
    check("audit_events_action_check", sql`length(${table.action}) BETWEEN 1 AND 64`),
    index("audit_events_workspace_id_created_at_idx").on(table.workspaceId, table.createdAt.desc(), table.id.desc()),
    index("audit_events_workspace_id_actor_account_id_idx").on(table.workspaceId, table.actorAccountId, table.createdAt.desc()),
    index("audit_events_workspace_id_entity_idx").on(table.workspaceId, table.entityType, table.entityId),
    // The retention purge selects by age across workspaces.
    index("audit_events_created_at_idx").on(table.createdAt),
    // The account deletion (`sys_delete_account`, doc 05 section 7.1) finds an account's events across every workspace: the
    // `actor_account_id` foreign-key action and the update of `ip_prefix` by the actor, the update of `entity_id` where it names the
    // account, and the removal of the `transferTo` and `targetId` metadata fields where they name it. Each index holds only the rows
    // that carry the column or field, and its expression is the one the statement compares.
    index("audit_events_actor_account_id_idx").on(table.actorAccountId).where(sql`${table.actorAccountId} IS NOT NULL`),
    index("audit_events_entity_id_idx").on(table.entityId).where(sql`${table.entityId} IS NOT NULL`),
    index("audit_events_transfer_to_idx")
      .on(sql`lower(${table.metadata} ->> 'transferTo')`)
      .where(sql`${table.metadata} ->> 'transferTo' IS NOT NULL`),
    index("audit_events_target_id_idx")
      .on(sql`lower(${table.metadata} ->> 'targetId')`)
      .where(sql`${table.metadata} ->> 'targetId' IS NOT NULL`),
  ],
);
