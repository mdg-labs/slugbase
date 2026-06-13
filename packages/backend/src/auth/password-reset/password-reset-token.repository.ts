import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { DrizzleClient } from "../../db/dialect/create-client.js";
import { passwordResetTokens } from "../../db/schema/index.js";

export interface PasswordResetTokenRecord {
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
}): PasswordResetTokenRecord {
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

export class PasswordResetTokenRepository {
  constructor(private readonly db: DrizzleClient) {}

  async create(
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<PasswordResetTokenRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

        const rows = await this.db
      .insert(passwordResetTokens)
      .values({
        id,
        userId,
        tokenHash,
        expiresAt: expiresAt.getTime(),
        createdAt: nowMs,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create password reset token");
    return toRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null> {

        const rows = await this.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toRecord(row);
  }

  async markUsed(id: string, nowMs: number): Promise<void> {

        await this.db
      .update(passwordResetTokens)
      .set({ usedAt: nowMs })
      .where(eq(passwordResetTokens.id, id));
  }
}
