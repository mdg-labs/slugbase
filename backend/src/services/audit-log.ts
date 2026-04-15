import type { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { execute, getDbType, query, queryOne } from '../db/index.js';
import { isCloud } from '../config/mode.js';
import { getTenantId, DEFAULT_TENANT_ID } from '../utils/tenant.js';

export type AuditEntityType =
  | 'bookmark'
  | 'folder'
  | 'tag'
  | 'team'
  | 'org_member'
  | 'team_member'
  | 'api_token'
  | 'oidc_provider'
  | 'settings'
  | 'user'
  | 'organization'
  | 'org_invitation';

export interface AuditEventPayload {
  action: string;
  entityType: AuditEntityType;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RecordAuditEventForTenantOptions {
  /** When set (including `null`), overrides `req.user` for the actor (e.g. Stripe webhooks use `null`). */
  actorUserId?: string | null;
}

/**
 * Whether audit rows should be persisted for this tenant.
 * Self-hosted: always true (single-tenant default id included).
 * Cloud: Team plan only, real org id (not `default`).
 */
export async function isAuditLogEnabledForTenantId(tenantId: string): Promise<boolean> {
  if (!isCloud) {
    return true;
  }
  if (!tenantId || tenantId === DEFAULT_TENANT_ID) {
    return false;
  }
  const row = await queryOne('SELECT plan FROM organizations WHERE id = ?', [tenantId]);
  return row != null && (row as { plan?: string }).plan === 'team';
}

/**
 * Cloud: Team plan with a real organization tenant (matches Members/Teams admin gating).
 * Self-hosted: always on.
 */
export async function isAuditLogEnabledForRequest(req: Request): Promise<boolean> {
  return isAuditLogEnabledForTenantId(getTenantId(req));
}

async function insertAuditRow(
  tenantId: string,
  actorUserId: string | null,
  payload: AuditEventPayload
): Promise<void> {
  const id = uuidv4();
  const meta = payload.metadata ?? {};
  const metaStr = JSON.stringify(meta);
  const entityId = payload.entityId ?? null;

  if (getDbType() === 'postgresql') {
    await execute(
      `INSERT INTO audit_events (id, tenant_id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, CURRENT_TIMESTAMP)`,
      [id, tenantId, actorUserId, payload.action, payload.entityType, entityId, metaStr]
    );
  } else {
    await execute(
      `INSERT INTO audit_events (id, tenant_id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [id, tenantId, actorUserId, payload.action, payload.entityType, entityId, metaStr]
    );
  }
}

/**
 * Insert an audit row for a specific tenant (e.g. cloud org id for invitation accept or Stripe updates).
 * Use `options.actorUserId: null` for non-user actors (e.g. webhooks).
 */
export async function recordAuditEventForTenant(
  req: Request,
  tenantId: string,
  payload: AuditEventPayload,
  options?: RecordAuditEventForTenantOptions
): Promise<void> {
  try {
    if (!(await isAuditLogEnabledForTenantId(tenantId))) {
      return;
    }
    const authUser = (req as Request & { user?: { id: string } }).user;
    const actorUserId =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, 'actorUserId')
        ? options.actorUserId ?? null
        : authUser?.id ?? null;
    await insertAuditRow(tenantId, actorUserId, payload);
  } catch (err) {
    console.error('audit_events insert failed:', err);
  }
}

export async function recordAuditEvent(req: Request, payload: AuditEventPayload): Promise<void> {
  return recordAuditEventForTenant(req, getTenantId(req), payload);
}

export interface AuditEventRow {
  id: string;
  tenant_id: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: string | Record<string, unknown> | null;
  created_at: string;
  actor_email: string | null;
  actor_name: string | null;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw) as unknown;
      return typeof o === 'object' && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

export async function listAuditEvents(
  tenantId: string,
  options: { limit: number; beforeCreatedAt?: string; beforeId?: string }
): Promise<AuditEventRow[]> {
  const lim = Math.min(Math.max(options.limit, 1), 100);
  let sql = `
    SELECT e.id, e.tenant_id, e.actor_user_id, e.action, e.entity_type, e.entity_id, e.metadata, e.created_at,
           u.email AS actor_email, u.name AS actor_name
    FROM audit_events e
    LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE e.tenant_id = ?`;
  const params: unknown[] = [tenantId];

  if (options.beforeCreatedAt && options.beforeId) {
    sql += ` AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))`;
    params.push(options.beforeCreatedAt, options.beforeCreatedAt, options.beforeId);
  }

  sql += ` ORDER BY e.created_at DESC, e.id DESC LIMIT ?`;
  params.push(lim);

  const rows = await query(sql, params);
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return list.map((r: any) => ({
    ...r,
    metadata: parseMetadata(r.metadata),
  })) as AuditEventRow[];
}
