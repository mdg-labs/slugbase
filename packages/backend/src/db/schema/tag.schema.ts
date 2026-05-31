import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** User-private bookmark label within a workspace (spec §7.2, §16). */
export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("tags_workspace_id_idx").on(t.workspaceId),
    index("tags_user_id_idx").on(t.userId),
    index("tags_workspace_user_id_idx").on(t.workspaceId, t.userId),
  ],
);
