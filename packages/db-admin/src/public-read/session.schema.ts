import { bigint, pgTable } from "drizzle-orm/pg-core";

/** Read-only mirror — admin PRD §8.5 (Active session counts). */
export const sessions = pgTable("sessions", {
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});
