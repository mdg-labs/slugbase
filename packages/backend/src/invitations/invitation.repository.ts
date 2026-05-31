import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import { workspaceInvitations as sqliteInvitations } from "../db/schema/index.js";
import { workspaceInvitations as pgInvitations } from "../db/schema/pg-index.js";
import type {
  CreateInvitationData,
  InvitationRole,
  WorkspaceInvitationRecord,
} from "./invitation.types.js";

function toRecord(row: {
  id: string;
  workspaceId: string;
  invitedEmail: string;
  role: string;
  tokenHash: string;
  invitedByUserId: string;
  acceptedAt: Date | number | null;
  expiresAt: Date | number;
  createdAt: Date | number;
}): WorkspaceInvitationRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    invitedEmail: row.invitedEmail,
    role: row.role as InvitationRole,
    tokenHash: row.tokenHash,
    invitedByUserId: row.invitedByUserId,
    acceptedAt:
      row.acceptedAt == null
        ? null
        : row.acceptedAt instanceof Date
          ? row.acceptedAt
          : new Date(row.acceptedAt),
    expiresAt:
      row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

export class InvitationRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async create(data: CreateInvitationData): Promise<WorkspaceInvitationRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteInvitations)
        .values({
          id,
          workspaceId: data.workspaceId,
          invitedEmail: data.invitedEmail,
          role: data.role,
          tokenHash: data.tokenHash,
          invitedByUserId: data.invitedByUserId,
          expiresAt: data.expiresAt,
          createdAt: new Date(nowMs),
        })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteInvitations)
        .where(eq(sqliteInvitations.id, id))
        .get();
      if (!row) throw new Error("Failed to create invitation");
      return toRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgInvitations)
      .values({
        id,
        workspaceId: data.workspaceId,
        invitedEmail: data.invitedEmail,
        role: data.role,
        tokenHash: data.tokenHash,
        invitedByUserId: data.invitedByUserId,
        expiresAt: data.expiresAt.getTime(),
        createdAt: nowMs,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create invitation");
    return toRecord(row);
  }

  async findByTokenHash(
    tokenHash: string,
  ): Promise<WorkspaceInvitationRecord | null> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteInvitations)
        .where(eq(sqliteInvitations.tokenHash, tokenHash))
        .get();
      return row ? toRecord(row) : null;
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgInvitations)
      .where(eq(pgInvitations.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findPendingByWorkspaceAndEmail(
    workspaceId: string,
    email: string,
  ): Promise<WorkspaceInvitationRecord | null> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteInvitations)
        .where(
          and(
            eq(sqliteInvitations.workspaceId, workspaceId),
            eq(sqliteInvitations.invitedEmail, email),
            isNull(sqliteInvitations.acceptedAt),
          ),
        )
        .get();
      return row ? toRecord(row) : null;
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgInvitations)
      .where(
        and(
          eq(pgInvitations.workspaceId, workspaceId),
          eq(pgInvitations.invitedEmail, email),
          isNull(pgInvitations.acceptedAt),
        ),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markAccepted(id: string, nowMs: number): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .update(sqliteInvitations)
        .set({ acceptedAt: new Date(nowMs) })
        .where(eq(sqliteInvitations.id, id))
        .run();
      return;
    }
    await (this.db as PostgresDrizzleClient)
      .update(pgInvitations)
      .set({ acceptedAt: nowMs })
      .where(eq(pgInvitations.id, id));
  }

  async findById(id: string): Promise<WorkspaceInvitationRecord | null> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteInvitations)
        .where(eq(sqliteInvitations.id, id))
        .get();
      return row ? toRecord(row) : null;
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgInvitations)
      .where(eq(pgInvitations.id, id))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findPendingByWorkspace(
    workspaceId: string,
  ): Promise<WorkspaceInvitationRecord[]> {
    if (this.dialect === "sqlite") {
      const rows = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteInvitations)
        .where(
          and(
            eq(sqliteInvitations.workspaceId, workspaceId),
            isNull(sqliteInvitations.acceptedAt),
          ),
        )
        .all();
      return rows.map(toRecord);
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgInvitations)
      .where(
        and(
          eq(pgInvitations.workspaceId, workspaceId),
          isNull(pgInvitations.acceptedAt),
        ),
      );
    return rows.map(toRecord);
  }

  async updateTokenAndExpiry(
    id: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<WorkspaceInvitationRecord | null> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .update(sqliteInvitations)
        .set({ tokenHash, expiresAt })
        .where(eq(sqliteInvitations.id, id))
        .run();
      return this.findById(id);
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .update(pgInvitations)
      .set({ tokenHash, expiresAt: expiresAt.getTime() })
      .where(eq(pgInvitations.id, id))
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async deleteById(id: string): Promise<boolean> {
    if (this.dialect === "sqlite") {
      const result = (this.db as SqliteDrizzleClient)
        .delete(sqliteInvitations)
        .where(eq(sqliteInvitations.id, id))
        .run();
      return result.changes > 0;
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .delete(pgInvitations)
      .where(eq(pgInvitations.id, id))
      .returning({ id: pgInvitations.id });
    return rows.length > 0;
  }
}
