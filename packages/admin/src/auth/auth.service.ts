import { adminUsers } from "@slugbase/db-admin/schema";
import { eq } from "drizzle-orm";

import type { AdminEnv } from "../config/env.schema.js";
import type { AdminDb } from "../db/create-db.js";
import type { AdminRole } from "./admin-roles.js";
import { AdminAuditService } from "./audit.service.js";
import { AdminPasswordService } from "./password.service.js";
import { AdminSessionService } from "./session.service.js";

export class AdminAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdminAuthError";
  }
}

export class AdminAuthService {
  private readonly passwords: AdminPasswordService;
  private readonly sessions: AdminSessionService;
  private readonly audit: AdminAuditService;

  constructor(
    private readonly adminDb: AdminDb,
    config: AdminEnv,
    passwords?: AdminPasswordService,
    sessions?: AdminSessionService,
    audit?: AdminAuditService,
  ) {
    this.passwords = passwords ?? new AdminPasswordService();
    this.sessions = sessions ?? new AdminSessionService(adminDb, config);
    this.audit = audit ?? new AdminAuditService(adminDb);
  }

  async login(input: {
    email: string;
    password: string;
  }): Promise<{ token: string; user: { id: string; email: string; role: AdminRole } }> {
    const normalizedEmail = input.email.trim().toLowerCase();

    const rows = await this.adminDb.db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.email, normalizedEmail))
      .limit(1);

    const user = rows[0];
    if (!user) {
      throw new AdminAuthError("Invalid email or password", 401);
    }

    const valid = await this.passwords.verifyPassword(
      user.passwordHash,
      input.password,
    );
    if (!valid) {
      throw new AdminAuthError("Invalid email or password", 401);
    }

    const session = await this.sessions.createSession({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    await this.sessions.touchLastLogin(user.id);

    await this.audit.record({
      adminUserId: user.id,
      action: "admin.login",
      targetType: "admin_user",
      targetId: user.id,
    });

    return {
      token: session.token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role as AdminRole,
      },
    };
  }
}
