import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { publicReadTables } from "./index.js";

export type PublicReadDb = ReturnType<typeof createPublicReadDb>;

export function createPublicReadDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 10 });
  const db = drizzle(sql, { schema: publicReadTables });

  return {
    db,
    sql,
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
