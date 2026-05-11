/**
 * Cloud-only: when an org admin "removes" a member, move that user to a new personal free
 * workspace and migrate their tenant-scoped data from the old org — instead of deleting the user row.
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { Pool } from 'pg';
import { getDb, getDbType, execute } from '../db/index.js';

function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

type ExecFn = (sql: string, params?: any[]) => Promise<void>;

function boolToDb(value: boolean | undefined | null): number | boolean | null {
  if (value === null || value === undefined) return null;
  if (getDbType() === 'postgresql') return value;
  return value ? 1 : 0;
}

/**
 * Run work inside a DB transaction. On PostgreSQL all statements use a single pooled client.
 */
async function runSpinOffTransaction(work: (ex: ExecFn) => Promise<void>): Promise<void> {
  if (getDbType() === 'postgresql') {
    const pool = getDb() as Pool;
    const client = await pool.connect();
    const ex: ExecFn = async (sql, params = []) => {
      const processed = params.map((p) => (typeof p === 'boolean' ? boolToDb(p) : p));
      await client.query(toPg(sql), processed);
    };
    try {
      await client.query('BEGIN');
      await work(ex);
      await client.query('COMMIT');
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
    return;
  }

  const sqlite = getDb() as Database.Database;
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    await work(async (sql, params = []) => {
      await execute(sql, params);
    });
    sqlite.exec('COMMIT');
  } catch (e) {
    try {
      sqlite.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export interface SpinOffCloudUserParams {
  userId: string;
  fromTenantId: string;
  userEmail: string;
}

export interface SpinOffCloudUserResult {
  newOrgId: string;
}

/**
 * Create a free personal organization, remove the user from {@link fromTenantId}, migrate their
 * bookmarks/folders/tags and related rows to the new tenant, and strip team membership and shares in the old org.
 */
export async function spinOffCloudUserFromOrg(params: SpinOffCloudUserParams): Promise<SpinOffCloudUserResult> {
  const { userId, fromTenantId, userEmail } = params;
  const newOrgId = randomUUID();
  const local = userEmail.includes('@') ? userEmail.split('@')[0] : userEmail;
  const orgName = `${local}'s workspace`;

  await runSpinOffTransaction(async (ex) => {
    await ex(
      `INSERT INTO organizations (id, name, plan, included_seats) VALUES (?, ?, ?, ?)`,
      [newOrgId, orgName, 'free', 5]
    );

    await ex(`DELETE FROM org_members WHERE user_id = ? AND org_id = ?`, [userId, fromTenantId]);

    await ex(`INSERT INTO org_members (user_id, org_id, role) VALUES (?, ?, ?)`, [userId, newOrgId, 'owner']);

    await ex(`DELETE FROM team_members WHERE user_id = ? AND tenant_id = ?`, [userId, fromTenantId]);

    await ex(
      `DELETE FROM bookmark_team_shares WHERE tenant_id = ? AND bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ? AND tenant_id = ?)`,
      [fromTenantId, userId, fromTenantId]
    );
    await ex(
      `DELETE FROM folder_team_shares WHERE tenant_id = ? AND folder_id IN (SELECT id FROM folders WHERE user_id = ? AND tenant_id = ?)`,
      [fromTenantId, userId, fromTenantId]
    );

    await ex(
      `DELETE FROM bookmark_user_shares WHERE tenant_id = ? AND (user_id = ? OR bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ? AND tenant_id = ?))`,
      [fromTenantId, userId, userId, fromTenantId]
    );
    await ex(
      `DELETE FROM folder_user_shares WHERE tenant_id = ? AND (user_id = ? OR folder_id IN (SELECT id FROM folders WHERE user_id = ? AND tenant_id = ?))`,
      [fromTenantId, userId, userId, fromTenantId]
    );

    await ex(
      `UPDATE bookmark_folders SET tenant_id = ? WHERE tenant_id = ? AND bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ? AND tenant_id = ?)`,
      [newOrgId, fromTenantId, userId, fromTenantId]
    );
    await ex(
      `UPDATE bookmark_folders SET tenant_id = ? WHERE tenant_id = ? AND folder_id IN (SELECT id FROM folders WHERE user_id = ? AND tenant_id = ?)`,
      [newOrgId, fromTenantId, userId, fromTenantId]
    );
    await ex(
      `UPDATE bookmark_tags SET tenant_id = ? WHERE tenant_id = ? AND (bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ? AND tenant_id = ?) OR tag_id IN (SELECT id FROM tags WHERE user_id = ? AND tenant_id = ?))`,
      [newOrgId, fromTenantId, userId, fromTenantId, userId, fromTenantId]
    );

    await ex(`UPDATE bookmarks SET tenant_id = ? WHERE user_id = ? AND tenant_id = ?`, [newOrgId, userId, fromTenantId]);
    await ex(`UPDATE folders SET tenant_id = ? WHERE user_id = ? AND tenant_id = ?`, [newOrgId, userId, fromTenantId]);
    await ex(`UPDATE tags SET tenant_id = ? WHERE user_id = ? AND tenant_id = ?`, [newOrgId, userId, fromTenantId]);

    await ex(`UPDATE slug_preferences SET tenant_id = ? WHERE user_id = ? AND tenant_id = ?`, [newOrgId, userId, fromTenantId]);
    await ex(`UPDATE api_tokens SET tenant_id = ? WHERE user_id = ? AND tenant_id = ?`, [newOrgId, userId, fromTenantId]);
    await ex(`UPDATE ai_suggestions_cache SET tenant_id = ? WHERE user_id = ? AND tenant_id = ?`, [newOrgId, userId, fromTenantId]);
    await ex(`UPDATE ai_suggestion_usage SET tenant_id = ? WHERE user_id = ? AND tenant_id = ?`, [newOrgId, userId, fromTenantId]);
  });

  return { newOrgId };
}
