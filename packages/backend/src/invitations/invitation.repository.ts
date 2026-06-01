import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import { workspaceInvitations } from "../db/schema/index.js";
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
  constructor(private readonly db: DrizzleClient) {}

  async create(data: CreateInvitationData): Promise<WorkspaceInvitationRecord> {
    const id = randomUUID();
    const nowMs = Date.now();

        const rows = await this.db
      .insert(workspaceInvitations)
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

    const rows = await this.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findPendingByWorkspaceAndEmail(
    workspaceId: string,
    email: string,
  ): Promise<WorkspaceInvitationRecord | null> {

    const rows = await this.db
      .select()
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, workspaceId),
          eq(workspaceInvitations.invitedEmail, email),
          isNull(workspaceInvitations.acceptedAt),
        ),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markAccepted(id: string, nowMs: number): Promise<void> {

    await this.db
      .update(workspaceInvitations)
      .set({ acceptedAt: nowMs })
      .where(eq(workspaceInvitations.id, id));
  }

  async findById(id: string): Promise<WorkspaceInvitationRecord | null> {

    const rows = await this.db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, id))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findPendingByWorkspace(
    workspaceId: string,
  ): Promise<WorkspaceInvitationRecord[]> {

    const rows = await this.db
      .select()
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, workspaceId),
          isNull(workspaceInvitations.acceptedAt),
        ),
      );
    return rows.map(toRecord);
  }

  async updateTokenAndExpiry(
    id: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<WorkspaceInvitationRecord | null> {

    const rows = await this.db
      .update(workspaceInvitations)
      .set({ tokenHash, expiresAt: expiresAt.getTime() })
      .where(eq(workspaceInvitations.id, id))
      .returning();
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async deleteById(id: string): Promise<boolean> {

    const rows = await this.db
      .delete(workspaceInvitations)
      .where(eq(workspaceInvitations.id, id))
      .returning({ id: workspaceInvitations.id });
    return rows.length > 0;
  }
}
