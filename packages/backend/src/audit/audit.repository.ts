import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import { auditEvents as sqliteAuditEvents } from "../db/schema/index.js";
import { auditEvents as pgAuditEvents } from "../db/schema/pg-index.js";
import {
  WorkspaceScopedRepository,
  type WorkspaceOwned,
} from "../db/workspace-scoped.repository.js";
import type {
  AuditEventRecord,
  ParsedListAuditEventsQuery,
  RecordAuditEventData,
} from "./audit.types.js";
import type { AuditEntityType } from "./audit.validation.js";
import {
  parsePage,
  parsePageSize,
  sanitizeAuditMetadata,
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
  table: typeof sqliteAuditEvents | typeof pgAuditEvents,
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
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- forwards db + dialect
  constructor(db: DrizzleClient, dialect: DbDialect) {
    super(db, dialect);
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

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteAuditEvents)
        .values({ ...values, createdAt: new Date(nowMs) })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteAuditEvents)
        .where(eq(sqliteAuditEvents.id, id))
        .get();
      if (!row) throw new Error("Failed to append audit event");
      return this.assertOwnership(data.workspaceId, toRecord(row));
    }

    const pgDb = this.db as PostgresDrizzleClient;
    await pgDb.insert(pgAuditEvents).values({ ...values, createdAt: nowMs });

    const rows = await pgDb
      .select()
      .from(pgAuditEvents)
      .where(eq(pgAuditEvents.id, id))
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
        ? asc(
            this.dialect === "sqlite"
              ? sqliteAuditEvents.createdAt
              : pgAuditEvents.createdAt,
          )
        : desc(
            this.dialect === "sqlite"
              ? sqliteAuditEvents.createdAt
              : pgAuditEvents.createdAt,
          );

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const conditions = buildListConditions(
        workspaceId,
        query,
        sqliteAuditEvents,
      );
      const whereClause = and(...conditions);

      const countRow = sqliteDb
        .select({ count: sql<number>`count(*)` })
        .from(sqliteAuditEvents)
        .where(whereClause)
        .get();
      const total = countRow?.count ?? 0;

      const rows = sqliteDb
        .select()
        .from(sqliteAuditEvents)
        .where(whereClause)
        .orderBy(order)
        .limit(pageSize)
        .offset(offset)
        .all();

      const items = this.assertAllOwned(
        workspaceId,
        rows.map((row) => toRecord(row)),
      );
      return { items, total };
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const conditions = buildListConditions(workspaceId, query, pgAuditEvents);
    const whereClause = and(...conditions);

    const countRows = await pgDb
      .select({ count: sql<number>`count(*)` })
      .from(pgAuditEvents)
      .where(whereClause);
    const total = countRows[0]?.count ?? 0;

    const rows = await pgDb
      .select()
      .from(pgAuditEvents)
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
