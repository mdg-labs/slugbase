import { coerceCount } from "../../db/coerce-count.js";
import { randomUUID } from "node:crypto";

import { and, count, eq, gt, isNull } from "drizzle-orm";

import type { DrizzleClient } from "../../db/dialect/create-client.js";
import { emailVerificationTokens } from "../../db/schema/index.js";

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
  constructor(private readonly db: DrizzleClient) {}

  async create(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<EmailVerificationTokenRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

        const rows = await this.db
      .insert(emailVerificationTokens)
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

        const rows = await this.db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toRecord(row);
  }

  async markUsed(id: string, nowMs: number): Promise<void> {

        await this.db
      .update(emailVerificationTokens)
      .set({ usedAt: nowMs })
      .where(eq(emailVerificationTokens.id, id));
  }

  /**
   * Counts unused (not-yet-consumed) tokens created for this user within the
   * given time window. Used to enforce the resend rate limit.
   */
  async countRecentByUserId(userId: string, sinceMs: number): Promise<number> {

        const rows = await this.db
      .select({ value: count() })
      .from(emailVerificationTokens)
      .where(
        and(
          eq(emailVerificationTokens.userId, userId),
          isNull(emailVerificationTokens.usedAt),
          gt(emailVerificationTokens.createdAt, sinceMs),
        ),
      );
    return coerceCount(rows[0]?.value);
  }

  /** Marks all unused signup verification tokens for a user as consumed. */
  async invalidateUnusedByUserId(userId: string, nowMs: number): Promise<void> {

        await this.db
      .update(emailVerificationTokens)
      .set({ usedAt: nowMs })
      .where(
        and(
          eq(emailVerificationTokens.userId, userId),
          isNull(emailVerificationTokens.usedAt),
        ),
      );
  }
}
