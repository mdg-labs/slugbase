import { bigint, pgTable, text } from "drizzle-orm/pg-core";

export const instanceMetadata = pgTable("instance_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
