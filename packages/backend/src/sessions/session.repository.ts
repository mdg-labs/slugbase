import { eq } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import { sessions } from "../db/schema/index.js";
import type { SessionRecord } from "./session.types.js";

interface RawSessionRow {
  id: string;
  userId: string;
  expiresAtMs: number;
  createdAtMs: number;
  lastActivityAtMs: number;
  data: string;
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
  constructor(private readonly db: DrizzleClient) {}

  async create(
    id: string,
    userId: string,
    expiresAtMs: number,
    nowMs: number,
    data: string,
  ): Promise<void> {

        await this.db.insert(sessions).values({
      id,
      userId,
      expiresAt: expiresAtMs,
      createdAt: nowMs,
      lastActivityAt: nowMs,
      data,
    });
  }

  async findById(id: string): Promise<SessionRecord | null> {

        const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
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

        await this.db
      .update(sessions)
      .set({ lastActivityAt: nowMs, expiresAt: newExpiresAtMs })
      .where(eq(sessions.id, id));
  }

  async deleteById(id: string): Promise<void> {

        await this.db.delete(sessions).where(eq(sessions.id, id));
  }

  async deleteAllByUserId(userId: string): Promise<void> {

        await this.db.delete(sessions).where(eq(sessions.userId, userId));
  }

  async updateData(id: string, data: string, nowMs: number): Promise<void> {

        await this.db
      .update(sessions)
      .set({ data, lastActivityAt: nowMs })
      .where(eq(sessions.id, id));
  }
}
