import { eq } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "./dialect/create-client.js";
import type { DbDialect } from "./dialect/dialect.js";
import { instanceMetadata as sqliteInstanceMetadata } from "./schema/index.js";
import { instanceMetadata as pgInstanceMetadata } from "./schema/pg-index.js";

export class InstanceMetadataRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async get(key: string): Promise<string | null> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const row = sqliteDb
        .select({ value: sqliteInstanceMetadata.value })
        .from(sqliteInstanceMetadata)
        .where(eq(sqliteInstanceMetadata.key, key))
        .get();

      return row?.value ?? null;
    }

    const postgresDb = this.db as PostgresDrizzleClient;
    const rows = await postgresDb
      .select({ value: pgInstanceMetadata.value })
      .from(pgInstanceMetadata)
      .where(eq(pgInstanceMetadata.key, key));

    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const updatedAt = Date.now();

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteInstanceMetadata)
        .values({ key, value, updatedAt: new Date(updatedAt) })
        .onConflictDoUpdate({
          target: sqliteInstanceMetadata.key,
          set: { value, updatedAt: new Date(updatedAt) },
        })
        .run();

      return;
    }

    const postgresDb = this.db as PostgresDrizzleClient;
    await postgresDb
      .insert(pgInstanceMetadata)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({
        target: pgInstanceMetadata.key,
        set: { value, updatedAt },
      });
  }
}
