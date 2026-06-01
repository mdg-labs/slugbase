import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { schema, type AppSchema } from "../schema/index.js";
import { assertPostgresDatabaseUrl } from "./dialect.js";

export type DrizzleClient = PostgresJsDatabase<AppSchema>;

export interface DbClientHandle {
  client: DrizzleClient;
  close: () => Promise<void>;
}

export function createDbClient(databaseUrl: string): DbClientHandle {
  assertPostgresDatabaseUrl(databaseUrl);

  const sql = postgres(databaseUrl, { max: 1 });
  const client = drizzle(sql, { schema });

  return {
    client,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
