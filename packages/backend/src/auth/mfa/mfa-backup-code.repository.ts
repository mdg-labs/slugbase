import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import type { DrizzleClient } from "../../db/dialect/create-client.js";
import { mfaBackupCodes } from "../../db/schema/index.js";
import type { MfaBackupCodeRecord } from "./mfa.types.js";

function toRecord(row: {
  id: string;
  userId: string;
  codeHash: string;
  usedAt: Date | number | null;
  createdAt: Date | number;
}): MfaBackupCodeRecord {
  return {
    id: row.id,
    userId: row.userId,
    codeHash: row.codeHash,
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

export class MfaBackupCodeRepository {
  constructor(private readonly db: DrizzleClient) {}

  async createMany(userId: string, codeHashes: string[]): Promise<void> {
    const nowMs = Date.now();
    const rows = codeHashes.map((codeHash) => ({ id: randomUUID(), userId, codeHash, createdAt: nowMs }));

        await this.db.insert(mfaBackupCodes).values(rows);
  }

  async findUnusedByUserId(userId: string): Promise<MfaBackupCodeRecord[]> {

        const rows = await this.db
      .select()
      .from(mfaBackupCodes)
      .where(
        and(eq(mfaBackupCodes.userId, userId), isNull(mfaBackupCodes.usedAt)),
      );
    return rows.map(toRecord);
  }

  async markUsed(id: string, nowMs: number): Promise<void> {

        await this.db
      .update(mfaBackupCodes)
      .set({ usedAt: new Date(nowMs) })
      .where(eq(mfaBackupCodes.id, id));
  }

  async deleteAllByUserId(userId: string): Promise<void> {

        await this.db.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
  }
}
