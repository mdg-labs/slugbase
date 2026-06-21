import { auditEvents } from "@slugbase/db-admin/schema";
import type { InferInsertModel } from "drizzle-orm";

import type { AdminDb } from "../db/create-db.js";

export type AuditAction = "admin.invite" | "admin.revoke_invite" | "admin.login";

export class AdminAuditService {
  constructor(private readonly adminDb: AdminDb) {}

  async record(event: {
    adminUserId: string;
    action: AuditAction;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const row: InferInsertModel<typeof auditEvents> = {
      adminUserId: event.adminUserId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      metadata: event.metadata ?? null,
    };

    await this.adminDb.db.insert(auditEvents).values(row);
  }
}
