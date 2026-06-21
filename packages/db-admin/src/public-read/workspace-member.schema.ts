import { pgTable, text } from "drizzle-orm/pg-core";

/** Read-only mirror — admin PRD §8.5 (Memberships). */
export const workspaceMembers = pgTable("workspace_members", {
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
});
