import { adminSessions, adminUsers } from "@slugbase/db-admin/schema";
import { eq } from "drizzle-orm";

import type { AdminEnv } from "../config/env.schema.js";
import type { AdminDb } from "../db/create-db.js";
import {
  ADMIN_SESSION_COOKIE,
  type AdminSessionRecord,
  type AdminSessionUser,
} from "./auth.constants.js";
import { generateOpaqueToken, hashOpaqueToken } from "./token.util.js";

const DAYS_TO_MS = 24 * 60 * 60 * 1000;

export class AdminSessionService {
  constructor(
    private readonly adminDb: AdminDb,
    private readonly config: AdminEnv,
  ) {}

  private get ttlMs(): number {
    return this.config.ADMIN_SESSION_TTL_DAYS * DAYS_TO_MS;
  }

  async createSession(user: AdminSessionUser): Promise<{
    token: string;
    sessionId: string;
  }> {
    const token = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    const expiresAt = new Date(Date.now() + this.ttlMs);

    const [session] = await this.adminDb.db
      .insert(adminSessions)
      .values({
        adminUserId: user.id,
        tokenHash,
        expiresAt,
      })
      .returning({ id: adminSessions.id });

    if (!session) {
      throw new Error("Failed to create admin session");
    }

    return { token, sessionId: session.id };
  }

  async findSessionByToken(token: string): Promise<AdminSessionRecord | null> {
    const tokenHash = hashOpaqueToken(token);
    const now = new Date();

    const rows = await this.adminDb.db
      .select({
        sessionId: adminSessions.id,
        expiresAt: adminSessions.expiresAt,
        userId: adminUsers.id,
        email: adminUsers.email,
        role: adminUsers.role,
      })
      .from(adminSessions)
      .innerJoin(adminUsers, eq(adminSessions.adminUserId, adminUsers.id))
      .where(eq(adminSessions.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    if (row.expiresAt <= now) {
      await this.revokeSession(row.sessionId);
      return null;
    }

    return {
      sessionId: row.sessionId,
      user: {
        id: row.userId,
        email: row.email,
        role: row.role,
      },
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.adminDb.db
      .delete(adminSessions)
      .where(eq(adminSessions.id, sessionId));
  }

  async revokeByToken(token: string): Promise<void> {
    const tokenHash = hashOpaqueToken(token);
    await this.adminDb.db
      .delete(adminSessions)
      .where(eq(adminSessions.tokenHash, tokenHash));
  }

  async touchLastLogin(userId: string): Promise<void> {
    await this.adminDb.db
      .update(adminUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(adminUsers.id, userId));
  }
}

export { ADMIN_SESSION_COOKIE };
