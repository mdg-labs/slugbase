import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

/** Folder shared with a team; transitively exposes contained bookmarks (spec §16). */
export const folderTeamShares = pgTable(
  "folder_team_shares",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    folderId: text("folder_id").notNull(),
    teamId: text("team_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("folder_team_shares_workspace_folder_team_unique_idx").on(
      t.workspaceId,
      t.folderId,
      t.teamId,
    ),
    index("folder_team_shares_folder_id_idx").on(t.folderId),
    index("folder_team_shares_team_id_idx").on(t.teamId),
  ],
);
