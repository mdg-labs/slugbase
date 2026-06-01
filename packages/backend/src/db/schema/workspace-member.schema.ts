import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
    joinedAt: bigint("joined_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("workspace_members_workspace_user_unique_idx").on(
      t.workspaceId,
      t.userId,
    ),
    index("workspace_members_workspace_id_idx").on(t.workspaceId),
    index("workspace_members_user_id_idx").on(t.userId),
  ],
);
