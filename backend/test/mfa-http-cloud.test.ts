/**
 * MFA HTTP checks with SLUGBASE_MODE=cloud (email verification ordering).
 * Run only via `npm test` (separate Node process) so `config/mode` is not cached from self-hosted tests.
 *
 * OIDC `handleSuccess` cloud + unverified + MFA is not covered here (full OAuth not exercised); rely on
 * this test + code review for P0-04 ordering.
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
import { encryptTotpSecretForStorage, generateTotpSecret } from '../src/services/mfa-totp.js';
import { hashBackupCodeForStorage } from '../src/services/mfa-backup-codes.js';
import { signMfaPendingToken } from '../src/utils/mfa-pending-jwt.js';
import { MFA_PENDING_COOKIE_NAME } from '../src/config/cookies.js';

function getSetCookieLines(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

function parseSetCookieNames(res: Response): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of getSetCookieLines(res)) {
    const name = line.split('=')[0]?.trim();
    if (name) m.set(name, line);
  }
  return m;
}

function cookieHeaderFromMap(map: Map<string, string>): string {
  return [...map.values()].map((line) => line.split(';')[0]).join('; ');
}

let server: Server;
let baseUrl: string;

describe('MFA HTTP routes (cloud mode)', () => {
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

  it('mfa/verify with unverified user + valid backup code: 403 EMAIL_NOT_VERIFIED, backup unused', async () => {
    const email = `cloud-mfa-${uuidv4()}@test.local`;
    const id = uuidv4();
    const hash = await bcrypt.hash('mypassword', 4);
    const secret = generateTotpSecret();
    const enc = encryptTotpSecretForStorage(secret);
    const plaintextBackup = 'a1b2c3d4e5f67890';
    const codeHash = hashBackupCodeForStorage(plaintextBackup);
    const backupRowId = uuidv4();

    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash, mfa_enabled, mfa_totp_secret_enc, mfa_enrolled_at, email_verified)
       VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'), 0)`,
      [id, email, 'U', `key-${id.slice(0, 8)}`, hash, enc]
    );
    await execute(
      'INSERT INTO mfa_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)',
      [backupRowId, id, codeHash]
    );

    const pendingJwt = signMfaPendingToken(id);
    const cookies = new Map<string, string>();
    cookies.set(
      MFA_PENDING_COOKIE_NAME,
      `${MFA_PENDING_COOKIE_NAME}=${encodeURIComponent(pendingJwt)}`
    );

    const verifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeaderFromMap(cookies),
      },
      body: JSON.stringify({ code: plaintextBackup }),
    });
    assert.strictEqual(verifyRes.status, 403);
    const body = (await verifyRes.json()) as Record<string, unknown>;
    assert.strictEqual(body.code, 'EMAIL_NOT_VERIFIED');

    const row = await queryOne<{ used_at: string | null }>(
      'SELECT used_at FROM mfa_backup_codes WHERE id = ?',
      [backupRowId]
    );
    assert.ok(row);
    assert.strictEqual(row!.used_at, null);
  });
});
