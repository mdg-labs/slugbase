/** Admin package uses its own Drizzle bookkeeping table (shared DB, separate history). */
export const ADMIN_MIGRATIONS_SCHEMA = "drizzle";
export const ADMIN_MIGRATIONS_TABLE = "__drizzle_migrations_admin";
