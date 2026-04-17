/**
 * Migration: tenant-scoped audit_events for collaboration audit trail.
 */

import { execute } from '../index.js';

export const migrationId = '023';
export const migrationName = 'Audit events table';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(
      `
      CREATE TABLE IF NOT EXISTS audit_events (
        id VARCHAR(255) PRIMARY KEY,
        tenant_id VARCHAR(255) NOT NULL,
        actor_user_id VARCHAR(255),
        action VARCHAR(128) NOT NULL,
        entity_type VARCHAR(64) NOT NULL,
        entity_id VARCHAR(255),
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `,
      []
    );
    await execute(
      'CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_created ON audit_events(tenant_id, created_at DESC)',
      []
    );
  } else {
    await execute(
      `
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        actor_user_id TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        metadata TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `,
      []
    );
    await execute(
      'CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_created ON audit_events(tenant_id, created_at DESC)',
      []
    );
  }
}

export async function down() {
  await execute('DROP INDEX IF EXISTS idx_audit_events_tenant_created', []);
  await execute('DROP TABLE IF EXISTS audit_events', []);
}
