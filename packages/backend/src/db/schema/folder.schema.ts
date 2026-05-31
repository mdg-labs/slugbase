import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Named bookmark container owned by a user within a workspace (spec §7.1, §16). */
export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("folders_workspace_id_idx").on(t.workspaceId),
    index("folders_user_id_idx").on(t.userId),
    index("folders_workspace_user_id_idx").on(t.workspaceId, t.userId),
  ],
);
