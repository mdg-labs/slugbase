import type { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { execute, getDbType, query } from '../db/index.js';
import { isCloud } from '../config/mode.js';
import { getTenantId, DEFAULT_TENANT_ID } from '../utils/tenant.js';

export type AuditEntityType = 'bookmark' | 'folder' | 'tag' | 'team' | 'org_member' | 'team_member';

export interface AuditEventPayload {
  action: string;
  entityType: AuditEntityType;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Cloud: Team plan with a real organization tenant (matches Members/Teams admin gating).
 * Self-hosted: always on. We do not require multiple org members so solo Team workspaces still get the audit log.
 */
export async function isAuditLogEnabledForRequest(req: Request): Promise<boolean> {
  if (!isCloud) {
    return true;
  }
  const plan = (req as Request & { plan?: string }).plan;
  if (plan !== 'team') {
    return false;
  }
  const tenantId = getTenantId(req);
  if (!tenantId || tenantId === DEFAULT_TENANT_ID) {
    return false;
  }
  return true;
}

export async function recordAuditEvent(req: Request, payload: AuditEventPayload): Promise<void> {
  try {
    if (!(await isAuditLogEnabledForRequest(req))) {
      return;
    }
    const tenantId = getTenantId(req);
    const authUser = (req as Request & { user?: { id: string } }).user;
    const actorUserId = authUser?.id ?? null;
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
  } catch (err) {
    console.error('audit_events insert failed:', err);
  }
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
