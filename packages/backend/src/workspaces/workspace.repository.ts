import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import { workspaces } from "../db/schema/index.js";
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
  billingCustomerId: string | null;
  billingSubscriptionId: string | null;
  billingStatus: string | null;
  billingPeriodEnd: Date | number | null;
  permanentPersonal: boolean | number;
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
    billingCustomerId: row.billingCustomerId ?? null,
    billingSubscriptionId: row.billingSubscriptionId ?? null,
    billingStatus: row.billingStatus ?? null,
    billingPeriodEnd:
      row.billingPeriodEnd === null
        ? null
        : new Date(
            row.billingPeriodEnd instanceof Date
              ? row.billingPeriodEnd.getTime()
              : row.billingPeriodEnd,
          ),
    permanentPersonal: Boolean(row.permanentPersonal),
    createdAt: new Date(
      row.createdAt instanceof Date ? row.createdAt.getTime() : row.createdAt,
    ),
    updatedAt: new Date(
      row.updatedAt instanceof Date ? row.updatedAt.getTime() : row.updatedAt,
    ),
  };
}

export class WorkspaceRepository {
  constructor(private readonly db: DrizzleClient) {}

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
      permanentPersonal: false,
    };

        const rows = await this.db
      .insert(workspaces)
      .values({ ...values, createdAt: now, updatedAt: now })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create workspace");
    return toRecord(row);
  }

  async findById(id: string): Promise<WorkspaceRecord | null> {

    const rows = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findBySlug(slug: string): Promise<WorkspaceRecord | null> {

    const rows = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, slug))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByIds(ids: string[]): Promise<WorkspaceRecord[]> {
    if (ids.length === 0) return [];

    const rows = await this.db
      .select()
      .from(workspaces)
      .where(inArray(workspaces.id, ids));
    return rows.map(toRecord);
  }

  async update(id: string, patch: UpdateWorkspaceData): Promise<WorkspaceRecord | null> {
    const updatedAt = nowMs();

    const { billingPeriodEnd, ...rest } = patch;
    await this.db
      .update(workspaces)
      .set({
        ...rest,
        updatedAt,
        ...(billingPeriodEnd !== undefined
          ? { billingPeriodEnd: billingPeriodEnd?.getTime() ?? null }
          : {}),
      })
      .where(eq(workspaces.id, id));
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {

    await this.db
      .delete(workspaces)
      .where(eq(workspaces.id, id));
  }
}
