import { bigint, pgTable, text } from "drizzle-orm/pg-core";

/** Read-only mirror — admin PRD §8.5 (Invitations pending count). */
export const workspaceInvitations = pgTable("workspace_invitations", {
  workspaceId: text("workspace_id").notNull(),
  acceptedAt: bigint("accepted_at", { mode: "number" }),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});
