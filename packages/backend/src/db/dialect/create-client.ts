import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { pgSchema, type PgAppSchema } from "../schema/pg-index.js";
import { schema, type AppSchema } from "../schema/index.js";
import {
  parseSqliteFilePath,
  resolveDialect,
  type DbDialect,
} from "./dialect.js";

export type SqliteDrizzleClient = BetterSQLite3Database<AppSchema>;
export type PostgresDrizzleClient = PostgresJsDatabase<PgAppSchema>;
export type DrizzleClient = SqliteDrizzleClient | PostgresDrizzleClient;

export interface DbClientHandle {
  client: DrizzleClient;
  dialect: DbDialect;
  close: () => void | Promise<void>;
}

export function createDbClient(databaseUrl: string): DbClientHandle {
  const dialect = resolveDialect(databaseUrl);

  if (dialect === "sqlite") {
    const filePath = parseSqliteFilePath(databaseUrl);
    const native = new Database(filePath);
    const client = drizzle(native, { schema });

    return {
      client,
      dialect,
      close: () => {
        native.close();
      },
    };
  }

  const sql = postgres(databaseUrl, { max: 1 });
  const client = drizzlePostgres(sql, { schema: pgSchema });

  return {
    client,
    dialect,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
