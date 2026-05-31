import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../../db/dialect/create-client.js";
import type { DbDialect } from "../../db/dialect/dialect.js";
import { mfaBackupCodes as sqliteMfaBackupCodes } from "../../db/schema/index.js";
import { mfaBackupCodes as pgMfaBackupCodes } from "../../db/schema/pg-index.js";
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
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async createMany(userId: string, codeHashes: string[]): Promise<void> {
    const nowMs = Date.now();
    const rows = codeHashes.map((codeHash) => ({ id: randomUUID(), userId, codeHash, createdAt: nowMs }));

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      for (const row of rows) {
        sqliteDb
          .insert(sqliteMfaBackupCodes)
          .values({ ...row, createdAt: new Date(row.createdAt) })
          .run();
      }
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb.insert(pgMfaBackupCodes).values(rows);
  }

  async findUnusedByUserId(userId: string): Promise<MfaBackupCodeRecord[]> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const rows = sqliteDb
        .select()
        .from(sqliteMfaBackupCodes)
        .where(
          and(
            eq(sqliteMfaBackupCodes.userId, userId),
            isNull(sqliteMfaBackupCodes.usedAt),
          ),
        )
        .all();
      return rows.map(toRecord);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select()
      .from(pgMfaBackupCodes)
      .where(
        and(eq(pgMfaBackupCodes.userId, userId), isNull(pgMfaBackupCodes.usedAt)),
      );
    return rows.map(toRecord);
  }

  async markUsed(id: string, nowMs: number): Promise<void> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .update(sqliteMfaBackupCodes)
        .set({ usedAt: new Date(nowMs) })
        .where(eq(sqliteMfaBackupCodes.id, id))
        .run();
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb
      .update(pgMfaBackupCodes)
      .set({ usedAt: new Date(nowMs) })
      .where(eq(pgMfaBackupCodes.id, id));
  }

  async deleteAllByUserId(userId: string): Promise<void> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .delete(sqliteMfaBackupCodes)
        .where(eq(sqliteMfaBackupCodes.userId, userId))
        .run();
      return;
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb.delete(pgMfaBackupCodes).where(eq(pgMfaBackupCodes.userId, userId));
  }
}
