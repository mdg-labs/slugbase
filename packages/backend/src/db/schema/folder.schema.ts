import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

/** Named bookmark container owned by a user within a workspace (spec §7.1, §16). */
export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    color: text("color"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("folders_workspace_id_idx").on(t.workspaceId),
    index("folders_user_id_idx").on(t.userId),
    index("folders_workspace_user_id_idx").on(t.workspaceId, t.userId),
  ],
);
