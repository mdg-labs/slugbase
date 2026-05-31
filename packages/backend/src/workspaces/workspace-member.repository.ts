import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import { workspaceMembers as sqliteWorkspaceMembers } from "../db/schema/index.js";
import { workspaceMembers as pgWorkspaceMembers } from "../db/schema/pg-index.js";
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
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async create(data: CreateWorkspaceMemberData): Promise<WorkspaceMemberRecord> {
    const id = randomUUID();
    const now = nowMs();
    const values = {
      id,
      workspaceId: data.workspaceId,
      userId: data.userId,
      role: data.role,
    };

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteWorkspaceMembers)
        .values({ ...values, joinedAt: new Date(now) })
        .run();
      const row = sqliteDb
        .select()
        .from(sqliteWorkspaceMembers)
        .where(eq(sqliteWorkspaceMembers.id, id))
        .get();
      if (!row) throw new Error("Failed to create workspace member");
      return toRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgWorkspaceMembers)
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
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteWorkspaceMembers)
        .where(
          and(
            eq(sqliteWorkspaceMembers.workspaceId, workspaceId),
            eq(sqliteWorkspaceMembers.userId, userId),
          ),
        )
        .get();
      return row ? toRecord(row) : null;
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgWorkspaceMembers)
      .where(
        and(
          eq(pgWorkspaceMembers.workspaceId, workspaceId),
          eq(pgWorkspaceMembers.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findAllByWorkspace(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
    if (this.dialect === "sqlite") {
      const rows = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteWorkspaceMembers)
        .where(eq(sqliteWorkspaceMembers.workspaceId, workspaceId))
        .all();
      return rows.map(toRecord);
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgWorkspaceMembers)
      .where(eq(pgWorkspaceMembers.workspaceId, workspaceId));
    return rows.map(toRecord);
  }

  async findAllByUser(userId: string): Promise<WorkspaceMemberRecord[]> {
    if (this.dialect === "sqlite") {
      const rows = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteWorkspaceMembers)
        .where(eq(sqliteWorkspaceMembers.userId, userId))
        .all();
      return rows.map(toRecord);
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgWorkspaceMembers)
      .where(eq(pgWorkspaceMembers.userId, userId));
    return rows.map(toRecord);
  }

  async countOwners(workspaceId: string): Promise<number> {
    if (this.dialect === "sqlite") {
      const result = (this.db as SqliteDrizzleClient)
        .select({ count: sql<number>`count(*)` })
        .from(sqliteWorkspaceMembers)
        .where(
          and(
            eq(sqliteWorkspaceMembers.workspaceId, workspaceId),
            eq(sqliteWorkspaceMembers.role, "OWNER"),
          ),
        )
        .get();
      return result?.count ?? 0;
    }
    const result = await (this.db as PostgresDrizzleClient)
      .select({ count: sql<number>`count(*)` })
      .from(pgWorkspaceMembers)
      .where(
        and(
          eq(pgWorkspaceMembers.workspaceId, workspaceId),
          eq(pgWorkspaceMembers.role, "OWNER"),
        ),
      );
    return result[0]?.count ?? 0;
  }

  async update(
    workspaceId: string,
    userId: string,
    patch: UpdateWorkspaceMemberData,
  ): Promise<WorkspaceMemberRecord | null> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .update(sqliteWorkspaceMembers)
        .set(patch)
        .where(
          and(
            eq(sqliteWorkspaceMembers.workspaceId, workspaceId),
            eq(sqliteWorkspaceMembers.userId, userId),
          ),
        )
        .run();
    } else {
      await (this.db as PostgresDrizzleClient)
        .update(pgWorkspaceMembers)
        .set(patch)
        .where(
          and(
            eq(pgWorkspaceMembers.workspaceId, workspaceId),
            eq(pgWorkspaceMembers.userId, userId),
          ),
        );
    }
    return this.findByWorkspaceAndUser(workspaceId, userId);
  }

  async delete(workspaceId: string, userId: string): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteWorkspaceMembers)
        .where(
          and(
            eq(sqliteWorkspaceMembers.workspaceId, workspaceId),
            eq(sqliteWorkspaceMembers.userId, userId),
          ),
        )
        .run();
      return;
    }
    await (this.db as PostgresDrizzleClient)
      .delete(pgWorkspaceMembers)
      .where(
        and(
          eq(pgWorkspaceMembers.workspaceId, workspaceId),
          eq(pgWorkspaceMembers.userId, userId),
        ),
      );
  }

  async deleteAllByWorkspace(workspaceId: string): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteWorkspaceMembers)
        .where(eq(sqliteWorkspaceMembers.workspaceId, workspaceId))
        .run();
      return;
    }
    await (this.db as PostgresDrizzleClient)
      .delete(pgWorkspaceMembers)
      .where(eq(pgWorkspaceMembers.workspaceId, workspaceId));
  }
}
