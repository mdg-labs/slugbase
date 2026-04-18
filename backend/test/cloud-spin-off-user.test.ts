/**
 * Cloud: admin remove = spin-off to personal org (not hard delete); cannot remove org owner.
 * Run with SLUGBASE_MODE=cloud (see backend package.json test script).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'http';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase, execute, queryOne } from '../src/db/index.js';
import session from 'express-session';
import express from 'express';
import { createApp } from '../src/app-factory.js';
import { registerCoreRoutes } from '../src/register-routes.js';
import { generateToken } from '../src/utils/jwt.js';
import { spinOffCloudUserFromOrg } from '../src/services/cloud-spin-off-user.js';
import { getCsrfAuthHeaders } from './helpers/csrf-fetch.js';

async function ensureCloudOrgTables(): Promise<void> {
  await execute(
    `CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT DEFAULT 'free',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      included_seats INTEGER DEFAULT 5,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    []
  );
  await execute(
    `CREATE TABLE IF NOT EXISTS org_members (
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, org_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
    )`,
    []
  );
  await execute(`CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id)`, []);
}

let server: Server;
let baseUrl: string;

describe('Cloud spin-off user from org', () => {
  before(async () => {
    await initDatabase();
    await ensureCloudOrgTables();

    const tenantMw: express.RequestHandler = (req, _res, next) => {
      const id = req.headers['x-org-id'];
      if (typeof id === 'string' && id.trim()) {
        (req as express.Request & { tenantId?: string }).tenantId = id.trim();
      }
      next();
    };

    const app = createApp({ sessionStore: new session.MemoryStore() as any, tenantMiddleware: tenantMw });
    registerCoreRoutes(app, {});
    await new Promise<void>((resolve, reject) => {
      server = createServer(app);
      server.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no listen address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  );

  it('spinOffCloudUserFromOrg migrates bookmarks and creates owner membership on new org', async () => {
    const orgOld = uuidv4();
    const uOwner = uuidv4();
    const uMember = uuidv4();
    const hash = await bcrypt.hash('x', 4);
    await execute(`INSERT INTO organizations (id, name, plan, included_seats) VALUES (?, ?, 'team', 5)`, [
      orgOld,
      'Team Org',
    ]);
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)`,
      [uOwner, `o-${uOwner.slice(0, 6)}@t.local`, 'Owner', `k-o-${uOwner.slice(0, 6)}`, hash]
    );
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)`,
      [uMember, `m-${uMember.slice(0, 6)}@t.local`, 'Member', `k-m-${uMember.slice(0, 6)}`, hash]
    );
    await execute(`INSERT INTO org_members (user_id, org_id, role) VALUES (?, ?, 'owner')`, [uOwner, orgOld]);
    await execute(`INSERT INTO org_members (user_id, org_id, role) VALUES (?, ?, 'member')`, [uMember, orgOld]);

    const bm = uuidv4();
    await execute(
      `INSERT INTO bookmarks (id, tenant_id, user_id, title, url, slug, forwarding_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [bm, orgOld, uMember, 'Hi', 'https://example.com', 'my-slug', 0]
    );

    const { newOrgId } = await spinOffCloudUserFromOrg({
      userId: uMember,
      fromTenantId: orgOld,
      userEmail: `m-${uMember.slice(0, 6)}@t.local`,
    });

    const oldMem = await queryOne('SELECT 1 FROM org_members WHERE user_id = ? AND org_id = ?', [uMember, orgOld]);
    assert.strictEqual(oldMem, null);

    const newMem = await queryOne('SELECT role FROM org_members WHERE user_id = ? AND org_id = ?', [uMember, newOrgId]);
    assert.strictEqual((newMem as { role: string }).role, 'owner');

    const bmRow = await queryOne('SELECT tenant_id FROM bookmarks WHERE id = ?', [bm]);
    assert.strictEqual((bmRow as { tenant_id: string }).tenant_id, newOrgId);
  });

  it('DELETE admin user: 403 when target is org owner', async () => {
    const orgId = uuidv4();
    const uAdmin = uuidv4();
    const uOwner = uuidv4();
    const hash = await bcrypt.hash('x', 4);
    await execute(`INSERT INTO organizations (id, name, plan, included_seats) VALUES (?, ?, 'team', 5)`, [
      orgId,
      'Org',
    ]);
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)`,
      [uAdmin, `a-${uAdmin.slice(0, 6)}@t.local`, 'Adm', `k-a-${uAdmin.slice(0, 6)}`, hash]
    );
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)`,
      [uOwner, `w-${uOwner.slice(0, 6)}@t.local`, 'Own', `k-w-${uOwner.slice(0, 6)}`, hash]
    );
    await execute(`INSERT INTO org_members (user_id, org_id, role) VALUES (?, ?, 'admin')`, [uAdmin, orgId]);
    await execute(`INSERT INTO org_members (user_id, org_id, role) VALUES (?, ?, 'owner')`, [uOwner, orgId]);

    const jwt = generateToken({
      id: uAdmin,
      email: `a-${uAdmin.slice(0, 6)}@t.local`,
      name: 'Adm',
      user_key: `k-a-${uAdmin.slice(0, 6)}`,
      is_admin: false,
    });
    const csrf = await getCsrfAuthHeaders(baseUrl);
    const res = await fetch(`${baseUrl}/api/admin/users/${uOwner}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'x-org-id': orgId,
        ...csrf,
      },
    });
    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.ok(String(body.error || '').includes('owner'));
  });

  it('DELETE admin user: spin-off for non-owner member', async () => {
    const orgId = uuidv4();
    const uAdmin = uuidv4();
    const uMember = uuidv4();
    const hash = await bcrypt.hash('x', 4);
    await execute(`INSERT INTO organizations (id, name, plan, included_seats) VALUES (?, ?, 'team', 5)`, [
      orgId,
      'Org B',
    ]);
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)`,
      [uAdmin, `b-${uAdmin.slice(0, 6)}@t.local`, 'Adm', `k-b-${uAdmin.slice(0, 6)}`, hash]
    );
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)`,
      [uMember, `c-${uMember.slice(0, 6)}@t.local`, 'Mem', `k-c-${uMember.slice(0, 6)}`, hash]
    );
    await execute(`INSERT INTO org_members (user_id, org_id, role) VALUES (?, ?, 'admin')`, [uAdmin, orgId]);
    await execute(`INSERT INTO org_members (user_id, org_id, role) VALUES (?, ?, 'member')`, [uMember, orgId]);

    const jwt = generateToken({
      id: uAdmin,
      email: `b-${uAdmin.slice(0, 6)}@t.local`,
      name: 'Adm',
      user_key: `k-b-${uAdmin.slice(0, 6)}`,
      is_admin: false,
    });
    const csrf = await getCsrfAuthHeaders(baseUrl);
    const res = await fetch(`${baseUrl}/api/admin/users/${uMember}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'x-org-id': orgId,
        ...csrf,
      },
    });
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { message?: string; new_org_id?: string };
    assert.ok(body.message?.includes('personal workspace'));
    assert.ok(body.new_org_id && body.new_org_id.length > 0);

    const userStill = await queryOne('SELECT id FROM users WHERE id = ?', [uMember]);
    assert.ok(userStill);
  });
});
