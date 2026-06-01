import { coerceCount } from "../db/coerce-count.js";
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import { workspaceMembers } from "../db/schema/index.js";
import type {
  CreateWorkspaceMemberData,
  UpdateWorkspaceMemberData,
  WorkspaceMemberRecord,
  WorkspaceMemberRole,
} from "./workspace.types.js";

function nowMs(): number {
  return Date.now();
}

function toRecord(row: {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  joinedAt: Date | number;
}): WorkspaceMemberRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: row.role as WorkspaceMemberRole,
    joinedAt: new Date(
      row.joinedAt instanceof Date ? row.joinedAt.getTime() : row.joinedAt,
    ),
  };
}

export class WorkspaceMemberRepository {
  constructor(private readonly db: DrizzleClient) {}

  async create(data: CreateWorkspaceMemberData): Promise<WorkspaceMemberRecord> {
    const id = randomUUID();
    const now = nowMs();
    const values = {
      id,
      workspaceId: data.workspaceId,
      userId: data.userId,
      role: data.role,
    };

        const rows = await this.db
      .insert(workspaceMembers)
      .values({ ...values, joinedAt: now })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create workspace member");
    return toRecord(row);
  }

  async findByWorkspaceAndUser(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberRecord | null> {

    const rows = await this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findAllByWorkspace(workspaceId: string): Promise<WorkspaceMemberRecord[]> {

    const rows = await this.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    return rows.map(toRecord);
  }

  async findAllByUser(userId: string): Promise<WorkspaceMemberRecord[]> {

    const rows = await this.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId));
    return rows.map(toRecord);
  }

  async countOwners(workspaceId: string): Promise<number> {

    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.role, "OWNER"),
        ),
      );
    return coerceCount(result[0]?.count);
  }

  async update(
    workspaceId: string,
    userId: string,
    patch: UpdateWorkspaceMemberData,
  ): Promise<WorkspaceMemberRecord | null> {

    await this.db
        .update(workspaceMembers)
        .set(patch)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );

    return this.findByWorkspaceAndUser(workspaceId, userId);
  }

  async delete(workspaceId: string, userId: string): Promise<void> {

    await this.db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      );
  }

  async deleteAllByWorkspace(workspaceId: string): Promise<void> {

    await this.db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));
  }
}
