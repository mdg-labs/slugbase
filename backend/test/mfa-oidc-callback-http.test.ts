/**
 * OIDC callback: MFA-enabled users get access JWT directly (no SlugBase TOTP step-up).
 * Uses a mock Passport strategy registered as `mock_oidc_mfa_skip`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'http';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import passport from 'passport';
import Strategy from 'passport-strategy';
import { initDatabase, execute } from '../src/db/index.js';
import session from 'express-session';
import { createApp } from '../src/app-factory.js';
import { registerCoreRoutes } from '../src/register-routes.js';
import { encryptTotpSecretForStorage, generateTotpSecret } from '../src/services/mfa-totp.js';
import { MFA_PENDING_COOKIE_NAME } from '../src/config/cookies.js';

const MOCK_PROVIDER_KEY = 'mock_oidc_mfa_skip';

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

class MockOidcCallbackStrategy extends Strategy {
  constructor(private readonly mockUser: { id: string }) {
    super();
  }

  authenticate(): void {
    this.success(this.mockUser as any);
  }
}

let server: Server;
let baseUrl: string;

describe('OIDC callback skips SlugBase MFA step-up', () => {
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
        try {
          passport.unuse(MOCK_PROVIDER_KEY);
        } catch {
          /* ignore */
        }
        server.close((err) => (err ? reject(err) : resolve()));
      })
  );

  it('GET /callback with MFA-enabled user issues token cookie, not mfa_pending', async () => {
    const email = `oidc-mfa-skip-${uuidv4()}@test.local`;
    const id = uuidv4();
    const secret = generateTotpSecret();
    const enc = encryptTotpSecretForStorage(secret);
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash, mfa_enabled, mfa_totp_secret_enc, mfa_enrolled_at, oidc_provider, oidc_sub)
       VALUES (?, ?, ?, ?, NULL, 1, ?, datetime('now'), 'test_oidc', ?)`,
      [id, email, 'Oidc User', `key-${id.slice(0, 8)}`, enc, 'oidc-sub-test']
    );

    passport.use(MOCK_PROVIDER_KEY, new MockOidcCallbackStrategy({ id }));

    const res = await fetch(`${baseUrl}/api/auth/${MOCK_PROVIDER_KEY}/callback`, {
      redirect: 'manual',
    });

    assert.ok(res.status === 302 || res.status === 301, `expected redirect, got ${res.status}`);
    const loc = res.headers.get('location') || '';
    assert.ok(loc.includes('localhost:3000') || loc.endsWith('/'), `unexpected Location: ${loc}`);

    const cookies = parseSetCookieNames(res);
    assert.ok(cookies.has('token'), 'access token cookie should be set');
    assert.strictEqual(cookies.has(MFA_PENDING_COOKIE_NAME), false, 'mfa_pending cookie must not be set after OIDC');
  });

  it('hybrid user: password login still requires MFA when mfa_enabled', async () => {
    const email = `hybrid-mfa-${uuidv4()}@test.local`;
    const id = uuidv4();
    const hash = await bcrypt.hash('mypassword', 4);
    const secret = generateTotpSecret();
    const enc = encryptTotpSecretForStorage(secret);
    await execute(
      `INSERT INTO users (id, email, name, user_key, password_hash, mfa_enabled, mfa_totp_secret_enc, mfa_enrolled_at, oidc_provider, oidc_sub)
       VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'), 'test_oidc', ?)`,
      [id, email, 'Hybrid', `key-${id.slice(0, 8)}`, hash, enc, 'oidc-sub-2']
    );

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'mypassword' }),
    });
    assert.strictEqual(loginRes.status, 200);
    const loginJson = (await loginRes.json()) as Record<string, unknown>;
    assert.strictEqual(loginJson.mfa_required, true);
    const cookies = parseSetCookieNames(loginRes);
    assert.ok(cookies.has(MFA_PENDING_COOKIE_NAME));
  });
});
