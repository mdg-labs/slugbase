import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

/** User-private bookmark label within a workspace (spec §7.2, §16). */
export const tags = pgTable(
  "tags",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("tags_workspace_id_idx").on(t.workspaceId),
    index("tags_user_id_idx").on(t.userId),
    index("tags_workspace_user_id_idx").on(t.workspaceId, t.userId),
  ],
);
