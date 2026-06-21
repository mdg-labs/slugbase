import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";

/** Read-only mirror — admin PRD §8.5 (Bookmarks aggregates). */
export const bookmarks = pgTable("bookmarks", {
  workspaceId: text("workspace_id").notNull(),
  planArchived: boolean("plan_archived").notNull(),
  accessCount: integer("access_count").notNull(),
});
