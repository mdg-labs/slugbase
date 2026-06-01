import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

/** Bookmark shared with a team (spec §16). */
export const bookmarkTeamShares = pgTable(
  "bookmark_team_shares",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    bookmarkId: text("bookmark_id").notNull(),
    teamId: text("team_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("bookmark_team_shares_workspace_bookmark_team_unique_idx").on(
      t.workspaceId,
      t.bookmarkId,
      t.teamId,
    ),
    index("bookmark_team_shares_bookmark_id_idx").on(t.bookmarkId),
    index("bookmark_team_shares_team_id_idx").on(t.teamId),
  ],
);
