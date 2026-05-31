import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../../db/dialect/create-client.js";
import type { DbDialect } from "../../db/dialect/dialect.js";
import { apiTokens as sqliteApiTokens } from "../../db/schema/index.js";
import { apiTokens as pgApiTokens } from "../../db/schema/pg-index.js";
import type { ApiTokenRecord, CreateApiTokenData } from "./api-token.types.js";

function toRecord(row: {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  lastUsedAt: Date | number | null;
  createdAt: Date | number;
  expiresAt: Date | number | null;
}): ApiTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    tokenHash: row.tokenHash,
    tokenPrefix: row.tokenPrefix,
    lastUsedAt:
      row.lastUsedAt == null
        ? null
        : row.lastUsedAt instanceof Date
          ? row.lastUsedAt
          : new Date(row.lastUsedAt),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    expiresAt:
      row.expiresAt == null
        ? null
        : row.expiresAt instanceof Date
          ? row.expiresAt
          : new Date(row.expiresAt),
  };
}

export class ApiTokenRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async create(data: CreateApiTokenData): Promise<ApiTokenRecord> {
    const id = randomUUID();
    const now = Date.now();
    const expiresAtMs = data.expiresAt?.getTime() ?? null;

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteApiTokens)
        .values({
          id,
          userId: data.userId,
          name: data.name,
          tokenHash: data.tokenHash,
          tokenPrefix: data.tokenPrefix,
          createdAt: new Date(now),
          expiresAt: expiresAtMs != null ? new Date(expiresAtMs) : null,
        })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteApiTokens)
        .where(eq(sqliteApiTokens.id, id))
        .get();

      if (!row) throw new Error("Failed to create API token");
      return toRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgApiTokens)
      .values({
        id,
        userId: data.userId,
        name: data.name,
        tokenHash: data.tokenHash,
        tokenPrefix: data.tokenPrefix,
        createdAt: now,
        expiresAt: expiresAtMs,
      })
      .returning();

    const row = rows[0];
    if (!row) throw new Error("Failed to create API token");
    return toRecord(row);
  }

  async findAllByUserId(userId: string): Promise<ApiTokenRecord[]> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const rows = sqliteDb
        .select()
        .from(sqliteApiTokens)
        .where(eq(sqliteApiTokens.userId, userId))
        .all();
      return rows.map(toRecord);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select()
      .from(pgApiTokens)
      .where(eq(pgApiTokens.userId, userId));
    return rows.map(toRecord);
  }

  async findByPrefix(tokenPrefix: string): Promise<ApiTokenRecord[]> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const rows = sqliteDb
        .select()
        .from(sqliteApiTokens)
        .where(eq(sqliteApiTokens.tokenPrefix, tokenPrefix))
        .all();
      return rows.map(toRecord);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select()
      .from(pgApiTokens)
      .where(eq(pgApiTokens.tokenPrefix, tokenPrefix));
    return rows.map(toRecord);
  }

  async findByIdAndUserId(
    id: string,
    userId: string,
  ): Promise<ApiTokenRecord | null> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const row = sqliteDb
        .select()
        .from(sqliteApiTokens)
        .where(
          and(
            eq(sqliteApiTokens.id, id),
            eq(sqliteApiTokens.userId, userId),
          ),
        )
        .get();
      return row ? toRecord(row) : null;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select()
      .from(pgApiTokens)
      .where(
        and(eq(pgApiTokens.id, id), eq(pgApiTokens.userId, userId)),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async deleteByIdAndUserId(id: string, userId: string): Promise<boolean> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .delete(sqliteApiTokens)
        .where(
          and(
            eq(sqliteApiTokens.id, id),
            eq(sqliteApiTokens.userId, userId),
          ),
        )
        .run();
      return true;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb
      .delete(pgApiTokens)
      .where(and(eq(pgApiTokens.id, id), eq(pgApiTokens.userId, userId)));
    return true;
  }

  async touchLastUsed(id: string, nowMs: number): Promise<void> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .update(sqliteApiTokens)
        .set({ lastUsedAt: new Date(nowMs) })
        .where(eq(sqliteApiTokens.id, id))
        .run();
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb
      .update(pgApiTokens)
      .set({ lastUsedAt: nowMs })
      .where(eq(pgApiTokens.id, id));
  }

  async countByUserId(userId: string): Promise<number> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const rows = sqliteDb
        .select({ id: sqliteApiTokens.id })
        .from(sqliteApiTokens)
        .where(eq(sqliteApiTokens.userId, userId))
        .all();
      return rows.length;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select({ id: pgApiTokens.id })
      .from(pgApiTokens)
      .where(eq(pgApiTokens.userId, userId));
    return rows.length;
  }
}
