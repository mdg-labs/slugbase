import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { schema, type AppSchema } from "../schema/index.js";
import {
  parseSqliteFilePath,
  resolveDialect,
  type DbDialect,
} from "./dialect.js";

export type DrizzleClient = BetterSQLite3Database<AppSchema>;

export interface DbClientHandle {
  client: DrizzleClient;
  dialect: DbDialect;
  close: () => void;
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

  throw new Error(
    "Postgres persistence is not wired in this release slice — use sqlite DATABASE_URL",
  );
}
