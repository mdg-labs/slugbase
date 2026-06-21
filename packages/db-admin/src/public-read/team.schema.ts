import { pgTable, text } from "drizzle-orm/pg-core";

/** Read-only mirror — admin PRD §8.5 (Teams counts). */
export const teams = pgTable("teams", {
  id: text("id").notNull(),
  workspaceId: text("workspace_id").notNull(),
});
