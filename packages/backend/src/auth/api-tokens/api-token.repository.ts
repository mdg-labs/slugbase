import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { DrizzleClient } from "../../db/dialect/create-client.js";
import { apiTokens } from "../../db/schema/index.js";
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
  constructor(private readonly db: DrizzleClient) {}

  async create(data: CreateApiTokenData): Promise<ApiTokenRecord> {
    const id = randomUUID();
    const now = Date.now();
    const expiresAtMs = data.expiresAt?.getTime() ?? null;

        const rows = await this.db
      .insert(apiTokens)
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

        const rows = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId));
    return rows.map(toRecord);
  }

  async findByPrefix(tokenPrefix: string): Promise<ApiTokenRecord[]> {

        const rows = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenPrefix, tokenPrefix));
    return rows.map(toRecord);
  }

  async findByIdAndUserId(
    id: string,
    userId: string,
  ): Promise<ApiTokenRecord | null> {

        const rows = await this.db
      .select()
      .from(apiTokens)
      .where(
        and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async deleteByIdAndUserId(id: string, userId: string): Promise<boolean> {

        await this.db
      .delete(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)));
    return true;
  }

  async touchLastUsed(id: string, nowMs: number): Promise<void> {

        await this.db
      .update(apiTokens)
      .set({ lastUsedAt: nowMs })
      .where(eq(apiTokens.id, id));
  }

  async countByUserId(userId: string): Promise<number> {

        const rows = await this.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId));
    return rows.length;
  }
}
