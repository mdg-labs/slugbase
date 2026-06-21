import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/**/*.schema.ts",
  out: "./migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL_UNPOOLED?.trim() ||
      process.env.DATABASE_URL ||
      "postgresql://slugbase:slugbase@localhost:5432/slugbase",
  },
});
