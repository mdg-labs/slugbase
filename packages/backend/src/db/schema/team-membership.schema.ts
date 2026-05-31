import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Associates workspace members with teams (spec §16). */
export const teamMemberships = sqliteTable(
  "team_memberships",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("team_memberships_workspace_team_user_unique_idx").on(
      t.workspaceId,
      t.teamId,
      t.userId,
    ),
    index("team_memberships_team_id_idx").on(t.teamId),
    index("team_memberships_user_id_idx").on(t.userId),
  ],
);
