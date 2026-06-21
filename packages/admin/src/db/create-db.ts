import { adminTables } from "@slugbase/db-admin/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type AdminDb = ReturnType<typeof createAdminDb>;

export function createAdminDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 10 });
  const db = drizzle(sql, { schema: adminTables });

  return {
    db,
    sql,
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
