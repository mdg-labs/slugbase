import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import { workspaces as sqliteWorkspaces } from "../db/schema/index.js";
import { workspaces as pgWorkspaces } from "../db/schema/pg-index.js";
import type {
  CreateWorkspaceData,
  UpdateWorkspaceData,
  WorkspacePlan,
  WorkspaceRecord,
} from "./workspace.types.js";

function nowMs(): number {
  return Date.now();
}

function toRecord(row: {
  id: string;
  name: string;
  slug: string;
  plan: string;
  planSeats: number | null;
  planArchived: boolean | number;
  createdAt: Date | number;
  updatedAt: Date | number;
}): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan as WorkspacePlan,
    planSeats: row.planSeats ?? null,
    planArchived: Boolean(row.planArchived),
    createdAt: new Date(
      row.createdAt instanceof Date ? row.createdAt.getTime() : row.createdAt,
    ),
    updatedAt: new Date(
      row.updatedAt instanceof Date ? row.updatedAt.getTime() : row.updatedAt,
    ),
  };
}

export class WorkspaceRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async create(data: CreateWorkspaceData): Promise<WorkspaceRecord> {
    const id = randomUUID();
    const now = nowMs();
    const values = {
      id,
      name: data.name,
      slug: data.slug,
      plan: data.plan ?? "free",
      planSeats: data.planSeats ?? null,
      planArchived: false,
    };

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteWorkspaces)
        .values({ ...values, createdAt: new Date(now), updatedAt: new Date(now) })
        .run();
      const row = sqliteDb
        .select()
        .from(sqliteWorkspaces)
        .where(eq(sqliteWorkspaces.id, id))
        .get();
      if (!row) throw new Error("Failed to create workspace");
      return toRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgWorkspaces)
      .values({ ...values, createdAt: now, updatedAt: now })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create workspace");
    return toRecord(row);
  }

  async findById(id: string): Promise<WorkspaceRecord | null> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteWorkspaces)
        .where(eq(sqliteWorkspaces.id, id))
        .get();
      return row ? toRecord(row) : null;
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgWorkspaces)
      .where(eq(pgWorkspaces.id, id))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findBySlug(slug: string): Promise<WorkspaceRecord | null> {
    if (this.dialect === "sqlite") {
      const row = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteWorkspaces)
        .where(eq(sqliteWorkspaces.slug, slug))
        .get();
      return row ? toRecord(row) : null;
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgWorkspaces)
      .where(eq(pgWorkspaces.slug, slug))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByIds(ids: string[]): Promise<WorkspaceRecord[]> {
    if (ids.length === 0) return [];

    if (this.dialect === "sqlite") {
      const rows = (this.db as SqliteDrizzleClient)
        .select()
        .from(sqliteWorkspaces)
        .where(inArray(sqliteWorkspaces.id, ids))
        .all();
      return rows.map(toRecord);
    }
    const rows = await (this.db as PostgresDrizzleClient)
      .select()
      .from(pgWorkspaces)
      .where(inArray(pgWorkspaces.id, ids));
    return rows.map(toRecord);
  }

  async update(id: string, patch: UpdateWorkspaceData): Promise<WorkspaceRecord | null> {
    const updatedAt = nowMs();
    const setPatch = { ...patch, updatedAt };

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .update(sqliteWorkspaces)
        .set({ ...setPatch, updatedAt: new Date(updatedAt) })
        .where(eq(sqliteWorkspaces.id, id))
        .run();
      return this.findById(id);
    }

    await (this.db as PostgresDrizzleClient)
      .update(pgWorkspaces)
      .set(setPatch)
      .where(eq(pgWorkspaces.id, id));
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    if (this.dialect === "sqlite") {
      (this.db as SqliteDrizzleClient)
        .delete(sqliteWorkspaces)
        .where(eq(sqliteWorkspaces.id, id))
        .run();
      return;
    }
    await (this.db as PostgresDrizzleClient)
      .delete(pgWorkspaces)
      .where(eq(pgWorkspaces.id, id));
  }
}
