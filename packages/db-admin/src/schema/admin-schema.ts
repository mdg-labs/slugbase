import { pgSchema } from "drizzle-orm/pg-core";

/** Postgres schema for admin portal tables (admin PRD §7). */
export const adminSchema = pgSchema("admin");
