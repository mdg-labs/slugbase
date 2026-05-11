/**
 * Self-hosted: DELETE /api/admin/users/:id hard-deletes the user row.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'http';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase, execute, queryOne } from '../src/db/index.js';
import session from 'express-session';
import { createApp } from '../src/app-factory.js';
import { registerCoreRoutes } from '../src/register-routes.js';
import { generateToken } from '../src/utils/jwt.js';
import { getCsrfAuthHeaders } from './helpers/csrf-fetch.js';

let server: Server;
let baseUrl: string;

describe('Admin DELETE user (self-hosted)', () => {
  before(async () => {
    await initDatabase();
    const app = createApp({ sessionStore: new session.MemoryStore() as any });
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

  it('removes target user from the database', async () => {
    const adminId = uuidv4();
    const targetId = uuidv4();
    const hash = await bcrypt.hash('pw', 4);
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash, is_admin) VALUES (?, ?, ?, ?, ?, 1)`,
      [adminId, `adm-${adminId.slice(0, 8)}@t.local`, 'Admin', `k-adm-${adminId.slice(0, 6)}`, hash]
    );
    await execute(`INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)`, [
      targetId,
      `tgt-${targetId.slice(0, 8)}@t.local`,
      'Target',
      `k-tgt-${targetId.slice(0, 6)}`,
      hash,
    ]);

    const jwt = generateToken({
      id: adminId,
      email: `adm-${adminId.slice(0, 8)}@t.local`,
      name: 'Admin',
      user_key: `k-adm-${adminId.slice(0, 6)}`,
      is_admin: true,
    });

    const csrf = await getCsrfAuthHeaders(baseUrl);
    const res = await fetch(`${baseUrl}/api/admin/users/${targetId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...csrf,
      },
    });
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { message?: string };
    assert.strictEqual(body.message, 'User deleted');

    const gone = await queryOne('SELECT id FROM users WHERE id = ?', [targetId]);
    assert.strictEqual(gone, null);
  });
});
