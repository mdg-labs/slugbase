import { pgTable, text } from "drizzle-orm/pg-core";

/** Read-only mirror — admin PRD §8.5 (Tags counts). */
export const tags = pgTable("tags", {
  id: text("id").notNull(),
  workspaceId: text("workspace_id").notNull(),
});
