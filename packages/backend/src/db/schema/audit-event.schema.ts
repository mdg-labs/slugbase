import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

/** Append-only workspace audit trail (spec §10.1, §16). */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("audit_events_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("audit_events_workspace_actor_idx").on(t.workspaceId, t.actorUserId),
    index("audit_events_workspace_entity_type_idx").on(
      t.workspaceId,
      t.entityType,
    ),
  ],
);
