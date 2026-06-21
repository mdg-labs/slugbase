import { pgTable, text } from "drizzle-orm/pg-core";

/** Read-only mirror — admin PRD §8.5 (Team membership counts). */
export const teamMemberships = pgTable("team_memberships", {
  workspaceId: text("workspace_id").notNull(),
});
