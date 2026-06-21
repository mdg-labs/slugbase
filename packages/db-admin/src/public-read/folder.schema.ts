import { pgTable, text } from "drizzle-orm/pg-core";

/** Read-only mirror — admin PRD §8.5 (Folders counts). */
export const folders = pgTable("folders", {
  id: text("id").notNull(),
  workspaceId: text("workspace_id").notNull(),
});
