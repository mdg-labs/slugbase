/**
 * revoke refresh tokens + clear sessions keyed to a user id
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { initDatabase, execute, queryOne } from '../src/db/index.js';
import { invalidateUserAuth } from '../src/services/auth-revocation.js';

describe('invalidateUserAuth', () => {
  before(async () => {
    await initDatabase();
    await execute(
      `
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire DATETIME NOT NULL
      )
    `,
      []
    );
  });

  it('revokes refresh_tokens for user', async () => {
    const uid = uuidv4();
    const hash = await bcrypt.hash('x', 4);
    await execute(`INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)`, [
      uid,
      `rt-${uid.slice(0, 6)}@t.local`,
      'U',
      `k-${uid.slice(0, 6)}`,
      hash,
    ]);
    const rtId = uuidv4();
    const far = new Date(Date.now() + 86400000).toISOString();
    await execute(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked) VALUES (?, ?, ?, ?, 0)`,
      [rtId, uid, 'hash1', far]
    );
    await invalidateUserAuth(uid);
    const row = await queryOne(`SELECT revoked FROM refresh_tokens WHERE id = ?`, [rtId]);
    const rev = (row as { revoked?: unknown }).revoked;
    assert.strictEqual(rev === true || rev === 1, true);
  });

  it('deletes sessions with passport.user = userId unless excludeSid', async () => {
    const uid = uuidv4();
    const sid1 = uuidv4();
    const sid2 = uuidv4();
    const keepSid = uuidv4();
    const far = new Date(Date.now() + 86400000).toISOString();
    await execute(`INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)`, [
      sid1,
      JSON.stringify({ passport: { user: uid }, cookie: { originalMaxAge: 600000, maxAge: 600000 } }),
      far,
    ]);
    await execute(`INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)`, [
      sid2,
      JSON.stringify({ passport: { user: uid }, cookie: { originalMaxAge: 600000, maxAge: 600000 } }),
      far,
    ]);
    await execute(`INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)`, [
      keepSid,
      JSON.stringify({
        passport: { user: uid },
        cookie: { originalMaxAge: 600000, maxAge: 600000 },
      }),
      far,
    ]);

    await invalidateUserAuth(uid, { excludeSid: keepSid });

    const r1 = await queryOne(`SELECT sid FROM sessions WHERE sid = ?`, [sid1]);
    const r2 = await queryOne(`SELECT sid FROM sessions WHERE sid = ?`, [sid2]);
    const rk = await queryOne(`SELECT sid FROM sessions WHERE sid = ?`, [keepSid]);
    assert.strictEqual(r1, null);
    assert.strictEqual(r2, null);
    assert.ok(rk);
  });
});
