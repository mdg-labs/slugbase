import type { AuditEntityType, AuditSort } from "./audit.validation.js";

export interface AuditEventRecord {
  id: string;
  workspaceId: string;
  actorUserId: string;
  action: string;
  entityType: AuditEntityType;
  entityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditEventView extends AuditEventRecord {
  actorName: string | null;
  actorEmail: string | null;
}

export interface RecordAuditEventData {
  workspaceId: string;
  actorUserId: string;
  action: string;
  entityType: AuditEntityType;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Raw HTTP query - filters parsed in the service before listing. */
export interface ListAuditEventsQuery {
  q?: string;
  actorUserId?: string;
  entityType?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export interface ParsedListAuditEventsQuery {
  q?: string;
  actorUserId?: string;
  entityType?: AuditEntityType;
  sort: AuditSort;
  page: number;
  pageSize: number;
}

export interface PaginatedAuditEvents {
  items: AuditEventView[];
  total: number;
  page: number;
  pageSize: number;
}
