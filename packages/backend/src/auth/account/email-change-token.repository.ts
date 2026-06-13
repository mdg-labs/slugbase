import { coerceCount } from "../../db/coerce-count.js";
import { randomUUID } from "node:crypto";

import { and, count, eq, gt, isNull } from "drizzle-orm";

import type { DrizzleClient } from "../../db/dialect/create-client.js";
import { emailChangeTokens } from "../../db/schema/index.js";

export interface EmailChangeTokenRecord {
  id: string;
  userId: string;
  pendingEmail: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

function toRecord(row: {
  id: string;
  userId: string;
  pendingEmail: string;
  tokenHash: string;
  expiresAt: Date | number;
  usedAt: Date | number | null;
  createdAt: Date | number;
}): EmailChangeTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    pendingEmail: row.pendingEmail,
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

export class EmailChangeTokenRepository {
  constructor(private readonly db: DrizzleClient) {}

  async create(
    userId: string,
    pendingEmail: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<EmailChangeTokenRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

        await this.db.insert(emailChangeTokens).values({
      id,
      userId,
      pendingEmail,
      tokenHash,
      expiresAt: expiresAt.getTime(),
      createdAt: nowMs,
    });

    const rows = await this.db
      .select()
      .from(emailChangeTokens)
      .where(eq(emailChangeTokens.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("Failed to create email change token");
    return toRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<EmailChangeTokenRecord | null> {

        const rows = await this.db
      .select()
      .from(emailChangeTokens)
      .where(eq(emailChangeTokens.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toRecord(row);
  }

  async markUsed(id: string, nowMs: number): Promise<void> {

        await this.db
      .update(emailChangeTokens)
      .set({ usedAt: nowMs })
      .where(eq(emailChangeTokens.id, id));
  }

  async countRecentByUserId(userId: string, sinceMs: number): Promise<number> {

        const rows = await this.db
      .select({ value: count() })
      .from(emailChangeTokens)
      .where(
        and(
          eq(emailChangeTokens.userId, userId),
          isNull(emailChangeTokens.usedAt),
          gt(emailChangeTokens.createdAt, sinceMs),
        ),
      );
    return coerceCount(rows[0]?.value);
  }

  async invalidateUnusedByUserId(userId: string, nowMs: number): Promise<void> {

        await this.db
      .update(emailChangeTokens)
      .set({ usedAt: nowMs })
      .where(
        and(
          eq(emailChangeTokens.userId, userId),
          isNull(emailChangeTokens.usedAt),
        ),
      );
  }
}
