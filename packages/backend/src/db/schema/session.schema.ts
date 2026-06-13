import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    lastActivityAt: bigint("last_activity_at", { mode: "number" }).notNull(),
    data: text("data").notNull().default("{}"),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);
