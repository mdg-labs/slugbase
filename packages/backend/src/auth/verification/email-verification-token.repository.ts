import { randomUUID } from "node:crypto";

import { and, count, eq, gt, isNull } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../../db/dialect/create-client.js";
import type { DbDialect } from "../../db/dialect/dialect.js";
import { emailVerificationTokens as sqliteTokens } from "../../db/schema/index.js";
import { emailVerificationTokens as pgTokens } from "../../db/schema/pg-index.js";

export interface EmailVerificationTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

function toRecord(row: {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date | number;
  usedAt: Date | number | null;
  createdAt: Date | number;
}): EmailVerificationTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt),
    usedAt:
      row.usedAt == null
        ? null
        : row.usedAt instanceof Date
          ? row.usedAt
          : new Date(row.usedAt),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

export class EmailVerificationTokenRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async create(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<EmailVerificationTokenRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteTokens)
        .values({
          id,
          userId,
          tokenHash,
          expiresAt,
          createdAt: new Date(nowMs),
        })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteTokens)
        .where(eq(sqliteTokens.id, id))
        .get();
      if (!row) throw new Error("Failed to create email verification token");
      return toRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgTokens)
      .values({
        id,
        userId,
        tokenHash,
        expiresAt: expiresAt.getTime(),
        createdAt: nowMs,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create email verification token");
    return toRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationTokenRecord | null> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const row = sqliteDb
        .select()
        .from(sqliteTokens)
        .where(eq(sqliteTokens.tokenHash, tokenHash))
        .get();
      if (!row) return null;
      return toRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select()
      .from(pgTokens)
      .where(eq(pgTokens.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toRecord(row);
  }

  async markUsed(id: string, nowMs: number): Promise<void> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .update(sqliteTokens)
        .set({ usedAt: new Date(nowMs) })
        .where(eq(sqliteTokens.id, id))
        .run();
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb
      .update(pgTokens)
      .set({ usedAt: nowMs })
      .where(eq(pgTokens.id, id));
  }

  /**
   * Counts unused (not-yet-consumed) tokens created for this user within the
   * given time window. Used to enforce the resend rate limit.
   */
  async countRecentByUserId(userId: string, sinceMs: number): Promise<number> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const rows = sqliteDb
        .select({ value: count() })
        .from(sqliteTokens)
        .where(
          and(
            eq(sqliteTokens.userId, userId),
            isNull(sqliteTokens.usedAt),
            gt(sqliteTokens.createdAt, new Date(sinceMs)),
          ),
        )
        .all();
      return rows[0]?.value ?? 0;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select({ value: count() })
      .from(pgTokens)
      .where(
        and(
          eq(pgTokens.userId, userId),
          isNull(pgTokens.usedAt),
          gt(pgTokens.createdAt, sinceMs),
        ),
      );
    return rows[0]?.value ?? 0;
  }
}
