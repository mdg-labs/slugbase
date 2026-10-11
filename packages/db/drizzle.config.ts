import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` is the only way migrations are produced (doc 05 section
// 5.1); it runs drizzle-kit with this file. Migration files are named
// <timestamp>_<name>.sql, and the engine records them in drizzle.migrations_core.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  migrations: { schema: "drizzle", table: "migrations_core", prefix: "timestamp" },
});
