/**
 * MFA HTTP integration: login + mfa_required, verify, /me with pending vs access JWT.
 * Run via backend `npm test` (same env as other tests).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'http';
import bcrypt from 'bcryptjs';
import { generateSync } from 'otplib';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase, execute } from '../src/db/index.js';
import session from 'express-session';
import { createApp } from '../src/app-factory.js';
import { registerCoreRoutes } from '../src/register-routes.js';
import { encryptTotpSecretForStorage, generateTotpSecret } from '../src/services/mfa-totp.js';
import jwt from 'jsonwebtoken';
import { MFA_PENDING_PURPOSE } from '../src/utils/mfa-pending-jwt.js';
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

describe('MFA HTTP routes', () => {
  before(async () => {
    await initDatabase();
    /** MemoryStore: avoids DatabaseSessionStore's hourly interval keeping the test process alive. */
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

  it('wrong password: 401 and no mfa_required', async () => {
    const email = `http-wrong-${uuidv4()}@test.local`;
    const id = uuidv4();
    const hash = await bcrypt.hash('rightpass', 4);
    await execute(
      'INSERT INTO users (id, email, name, user_key, password_hash, mfa_enabled) VALUES (?, ?, ?, ?, ?, 1)',
      [id, email, 'U', `key-${id.slice(0, 8)}`, hash]
    );

    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrongpass' }),
    });
    assert.strictEqual(res.status, 401);
    const body = (await res.json()) as Record<string, unknown>;
    assert.strictEqual(body.mfa_required, undefined);
  });

  it('correct password + MFA: 200 mfa_required, pending cookie, no access session from /me', async () => {
    const email = `http-mfa-${uuidv4()}@test.local`;
    const id = uuidv4();
    const hash = await bcrypt.hash('mypassword', 4);
    const secret = generateTotpSecret();
    const enc = encryptTotpSecretForStorage(secret);
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash, mfa_enabled, mfa_totp_secret_enc, mfa_enrolled_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))`,
      [id, email, 'U', `key-${id.slice(0, 8)}`, hash, enc]
    );

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'mypassword' }),
    });
    assert.strictEqual(loginRes.status, 200);
    const loginJson = (await loginRes.json()) as Record<string, unknown>;
    assert.strictEqual(loginJson.mfa_required, true);
    assert.strictEqual(loginJson.email, undefined);

    const cookies = parseSetCookieNames(loginRes);
    assert.ok(cookies.has(MFA_PENDING_COOKIE_NAME), 'mfa_pending cookie set');
    const pendingLine = cookies.get(MFA_PENDING_COOKIE_NAME)!;
    assert.ok(pendingLine.includes('HttpOnly'), 'pending cookie httpOnly');

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookieHeaderFromMap(cookies) },
    });
    assert.strictEqual(meRes.status, 401);
  });

  it('POST /mfa/verify with pending cookie issues access JWT and /me returns mfa_enabled', async () => {
    const email = `http-verify-${uuidv4()}@test.local`;
    const id = uuidv4();
    const hash = await bcrypt.hash('mypassword', 4);
    const secret = generateTotpSecret();
    const enc = encryptTotpSecretForStorage(secret);
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash, mfa_enabled, mfa_totp_secret_enc, mfa_enrolled_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))`,
      [id, email, 'U', `key-${id.slice(0, 8)}`, hash, enc]
    );

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'mypassword' }),
    });
    const cookies = parseSetCookieNames(loginRes);
    const code = generateSync({ secret });

    const verifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeaderFromMap(cookies),
      },
      body: JSON.stringify({ code }),
    });
    assert.strictEqual(verifyRes.status, 200);
    const userJson = (await verifyRes.json()) as Record<string, unknown>;
    assert.strictEqual(userJson.email, email);

    const afterCookies = parseSetCookieNames(verifyRes);
    const merged = new Map(cookies);
    for (const [k, v] of afterCookies) merged.set(k, v);

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookieHeaderFromMap(merged) },
    });
    assert.strictEqual(meRes.status, 200);
    const me = (await meRes.json()) as Record<string, unknown>;
    assert.strictEqual(me.mfa_enabled, true);
  });

  it('mfa/verify rejects wrong code with generic Invalid code', async () => {
    const email = `http-bad-${uuidv4()}@test.local`;
    const id = uuidv4();
    const hash = await bcrypt.hash('mypassword', 4);
    const secret = generateTotpSecret();
    const enc = encryptTotpSecretForStorage(secret);
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash, mfa_enabled, mfa_totp_secret_enc, mfa_enrolled_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))`,
      [id, email, 'U', `key-${id.slice(0, 8)}`, hash, enc]
    );

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'mypassword' }),
    });
    const cookies = parseSetCookieNames(loginRes);

    const verifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeaderFromMap(cookies),
      },
      body: JSON.stringify({ code: '000000' }),
    });
    assert.strictEqual(verifyRes.status, 401);
    const body = (await verifyRes.json()) as Record<string, unknown>;
    assert.strictEqual(body.error, 'Invalid code');
  });

  it('GET /me with Bearer mfa_pending JWT returns 401', async () => {
    const pending = jwt.sign(
      { sub: uuidv4(), pur: MFA_PENDING_PURPOSE },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: 120 }
    );
    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${pending}` },
    });
    assert.strictEqual(res.status, 401);
  });

  it('logout clears token and mfa_pending cookies in Set-Cookie', async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const joined = getSetCookieLines(res).join('\n');
    assert.ok(joined.includes('token=') || joined.toLowerCase().includes('token='), 'token cleared');
    assert.ok(joined.includes(MFA_PENDING_COOKIE_NAME), 'mfa pending cleared');
  });
});
