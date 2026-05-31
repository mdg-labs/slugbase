import { eq } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import { sessions as sqliteSessions } from "../db/schema/index.js";
import { sessions as pgSessions } from "../db/schema/pg-index.js";
import type { SessionRecord } from "./session.types.js";

interface RawSessionRow {
  id: string;
  userId: string;
  expiresAtMs: number;
  createdAtMs: number;
  lastActivityAtMs: number;
  data: string;
}

function toMs(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

function toRecord(row: RawSessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: new Date(row.expiresAtMs),
    createdAt: new Date(row.createdAtMs),
    lastActivityAt: new Date(row.lastActivityAtMs),
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

export class SessionRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async create(
    id: string,
    userId: string,
    expiresAtMs: number,
    nowMs: number,
    data: string,
  ): Promise<void> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteSessions)
        .values({
          id,
          userId,
          expiresAt: new Date(expiresAtMs),
          createdAt: new Date(nowMs),
          lastActivityAt: new Date(nowMs),
          data,
        })
        .run();
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb.insert(pgSessions).values({
      id,
      userId,
      expiresAt: expiresAtMs,
      createdAt: nowMs,
      lastActivityAt: nowMs,
      data,
    });
  }

  async findById(id: string): Promise<SessionRecord | null> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const row = sqliteDb
        .select()
        .from(sqliteSessions)
        .where(eq(sqliteSessions.id, id))
        .get();

      if (!row) return null;

      return toRecord({
        id: row.id,
        userId: row.userId,
        expiresAtMs: toMs(row.expiresAt),
        createdAtMs: toMs(row.createdAt),
        lastActivityAtMs: toMs(row.lastActivityAt),
        data: row.data,
      });
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select()
      .from(pgSessions)
      .where(eq(pgSessions.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return toRecord({
      id: row.id,
      userId: row.userId,
      expiresAtMs: row.expiresAt,
      createdAtMs: row.createdAt,
      lastActivityAtMs: row.lastActivityAt,
      data: row.data,
    });
  }

  async touch(id: string, newExpiresAtMs: number, nowMs: number): Promise<void> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .update(sqliteSessions)
        .set({
          lastActivityAt: new Date(nowMs),
          expiresAt: new Date(newExpiresAtMs),
        })
        .where(eq(sqliteSessions.id, id))
        .run();
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb
      .update(pgSessions)
      .set({ lastActivityAt: nowMs, expiresAt: newExpiresAtMs })
      .where(eq(pgSessions.id, id));
  }

  async deleteById(id: string): Promise<void> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb.delete(sqliteSessions).where(eq(sqliteSessions.id, id)).run();
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb.delete(pgSessions).where(eq(pgSessions.id, id));
  }

  async deleteAllByUserId(userId: string): Promise<void> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .delete(sqliteSessions)
        .where(eq(sqliteSessions.userId, userId))
        .run();
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb.delete(pgSessions).where(eq(pgSessions.userId, userId));
  }
}
