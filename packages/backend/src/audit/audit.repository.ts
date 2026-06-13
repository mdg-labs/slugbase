import { coerceCount } from "../db/coerce-count.js";
import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import { auditEvents } from "../db/schema/index.js";
import {
  WorkspaceScopedRepository,
  type WorkspaceOwned,
} from "../db/workspace-scoped.repository.js";
import type {
  AuditEventRecord,
  ParsedListAuditEventsQuery,
  RecordAuditEventData,
} from "./audit.types.js";
import {
  parsePage,
  parsePageSize,
  sanitizeAuditMetadata,
  type AuditEntityType,
} from "./audit.validation.js";

type AuditEventRow = WorkspaceOwned & {
  id: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: string;
  createdAt: Date | number;
};

function toDate(value: Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function toRecord(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorUserId: row.actorUserId,
    action: row.action,
    entityType: row.entityType as AuditEntityType,
    entityId: row.entityId,
    metadata: parseMetadata(row.metadata),
    createdAt: toDate(row.createdAt),
  };
}

function escapeLikePattern(q: string): string {
  return q.replace(/[%_\\]/g, "\\$&");
}

function buildListConditions(
  workspaceId: string,
  query: ParsedListAuditEventsQuery,
  table: typeof auditEvents,
): SQL[] {
  const conditions: SQL[] = [eq(table.workspaceId, workspaceId)];

  if (query.actorUserId) {
    conditions.push(eq(table.actorUserId, query.actorUserId));
  }

  if (query.entityType) {
    conditions.push(eq(table.entityType, query.entityType));
  }

  if (query.q) {
    const pattern = `%${escapeLikePattern(query.q.trim())}%`;
    conditions.push(
      sql`(${table.action} LIKE ${pattern} ESCAPE '\\' OR ${table.entityId} LIKE ${pattern} ESCAPE '\\' OR ${table.metadata} LIKE ${pattern} ESCAPE '\\')`,
    );
  }

  return conditions;
}

export class AuditRepository extends WorkspaceScopedRepository<AuditEventRecord> {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db to WorkspaceScopedRepository
  constructor(db: DrizzleClient) {
    super(db);
  }

  async append(data: RecordAuditEventData): Promise<AuditEventRecord> {
    const id = randomUUID();
    const nowMs = Date.now();
    const metadata = sanitizeAuditMetadata(data.metadata);
    const metadataJson = JSON.stringify(metadata);

    const values = {
      id,
      workspaceId: data.workspaceId,
      actorUserId: data.actorUserId,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId ?? null,
      metadata: metadataJson,
    };

        await this.db.insert(auditEvents).values({ ...values, createdAt: nowMs });

    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("Failed to append audit event");
    return this.assertOwnership(data.workspaceId, toRecord(row));
  }

  async list(
    workspaceId: string,
    query: ParsedListAuditEventsQuery,
  ): Promise<{ items: AuditEventRecord[]; total: number }> {
    const page = parsePage(query.page);
    const pageSize = parsePageSize(query.pageSize);
    const offset = (page - 1) * pageSize;
    const order =
      query.sort === "created-asc"
        ? asc(auditEvents.createdAt,
          )
        : desc(auditEvents.createdAt,
          );

        const conditions = buildListConditions(workspaceId, query, auditEvents);
    const whereClause = and(...conditions);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(auditEvents)
      .where(whereClause);
    const total = coerceCount(countRows[0]?.count);

    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(whereClause)
      .orderBy(order)
      .limit(pageSize)
      .offset(offset);

    const items = this.assertAllOwned(
      workspaceId,
      rows.map((row) => toRecord(row)),
    );
    return { items, total };
  }
}
