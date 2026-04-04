/**
 * MFA user-service integration tests (enroll, verify, backup consumption, cancel, concurrency).
 * Run: DB_PATH=:memory: JWT_SECRET=... ENCRYPTION_KEY=... npm test
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import bcrypt from 'bcryptjs';
import { generateSync } from 'otplib';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase, queryOne, execute } from '../src/db/index.js';
import {
  enrollBegin,
  enrollConfirm,
  enrollCancel,
  verifyMfaStepUp,
  tryConsumeBackupCode,
} from '../src/services/mfa-user.js';
import { encryptTotpSecretForStorage, generateTotpSecret, decryptTotpSecretFromStorage } from '../src/services/mfa-totp.js';
import { hashBackupCodeForStorage } from '../src/services/mfa-backup-codes.js';
import jwt from 'jsonwebtoken';
import { MFA_PENDING_PURPOSE } from '../src/utils/mfa-pending-jwt.js';

async function insertUser(email: string, key: string): Promise<string> {
  const id = uuidv4();
  const hash = await bcrypt.hash('password123', 4);
  await execute(
    'INSERT INTO users (id, email, name, user_key, password_hash) VALUES (?, ?, ?, ?, ?)',
    [id, email, 'T', key, hash]
  );
  return id;
}

describe('MFA API / user service', () => {
  before(async () => {
    await initDatabase();
  });

  it('enroll begin overwrites unstaged secret; cancel clears it', async () => {
    const uid = await insertUser('cancel@test.local', 'cancel-key');
    const b1 = await enrollBegin(uid, 'cancel@test.local');
    assert.ok('otpauth_url' in b1);
    const row1 = await queryOne('SELECT mfa_totp_secret_enc FROM users WHERE id = ?', [uid]);
    assert.ok((row1 as any).mfa_totp_secret_enc);

    const b2 = await enrollBegin(uid, 'cancel@test.local');
    assert.ok('otpauth_url' in b2);
    assert.notStrictEqual((b1 as any).secret, (b2 as any).secret);

    const cancel = await enrollCancel(uid);
    assert.strictEqual(cancel.ok, true);
    const row2 = await queryOne('SELECT mfa_totp_secret_enc FROM users WHERE id = ?', [uid]);
    assert.strictEqual((row2 as any).mfa_totp_secret_enc, null);
  });

  it('enroll cancel is idempotent when there is no pending secret', async () => {
    const uid = await insertUser('idempotent@test.local', 'idem-key');
    const c1 = await enrollCancel(uid);
    assert.strictEqual(c1.ok, true);
    const c2 = await enrollCancel(uid);
    assert.strictEqual(c2.ok, true);
  });

  it('concurrent enrollConfirm: only one succeeds; exactly 10 backup rows', async () => {
    const uid = await insertUser('race@test.local', 'race-key');
    const began = await enrollBegin(uid, 'race@test.local');
    assert.ok('secret' in began);
    const secret = (began as { secret: string }).secret;
    const token = generateSync({ secret });
    const [a, b] = await Promise.all([enrollConfirm(uid, token), enrollConfirm(uid, token)]);
    const oks = [a, b].filter((r) => r.ok === true);
    assert.strictEqual(oks.length, 1);
    const fails = [a, b].filter((r) => !r.ok && r.reason === 'already_enabled');
    assert.strictEqual(fails.length, 1);
    const rows = await queryOne('SELECT COUNT(*) as c FROM mfa_backup_codes WHERE user_id = ?', [uid]);
    assert.strictEqual(Number((rows as any).c), 10);
  });

  it('enroll confirm returns backup codes; second confirm is already_enabled', async () => {
    const uid = await insertUser('confirm@test.local', 'confirm-key');
    const began = await enrollBegin(uid, 'confirm@test.local');
    assert.ok('secret' in began);
    const secret = (began as { secret: string }).secret;
    const token = generateSync({ secret });
    const confirmed = await enrollConfirm(uid, token);
    assert.strictEqual(confirmed.ok, true);
    if (confirmed.ok) {
      assert.strictEqual(confirmed.backup_codes.length, 10);
    }

    const again = await enrollConfirm(uid, '000000');
    assert.strictEqual(again.ok, false);
    if (!again.ok) {
      assert.strictEqual(again.reason, 'already_enabled');
    }
  });

  it('verifyMfaStepUp: wrong code, TOTP ok, backup consumed once', async () => {
    const uid = await insertUser('verify@test.local', 'verify-key');
    const began = await enrollBegin(uid, 'verify@test.local');
    const enrollSecret = (began as { secret: string }).secret;
    const confirmed = await enrollConfirm(uid, generateSync({ secret: enrollSecret }));
    assert.strictEqual(confirmed.ok, true);
    const backup0 = confirmed.ok ? confirmed.backup_codes[0] : '';

    assert.strictEqual(await verifyMfaStepUp(uid, '000000'), false);

    const row = await queryOne('SELECT mfa_totp_secret_enc FROM users WHERE id = ?', [uid]);
    const plain = decryptTotpSecretFromStorage((row as any).mfa_totp_secret_enc);
    const goodTotp = generateSync({ secret: plain });
    assert.strictEqual(await verifyMfaStepUp(uid, goodTotp), true);

    assert.strictEqual(await verifyMfaStepUp(uid, backup0), true);
    assert.strictEqual(await verifyMfaStepUp(uid, backup0), false);
  });

  it('tryConsumeBackupCode: concurrent consumers only one succeeds', async () => {
    const uid = await insertUser('conc@test.local', 'conc-key');
    await execute('UPDATE users SET mfa_enabled = 1, mfa_totp_secret_enc = ? WHERE id = ?', [
      encryptTotpSecretForStorage(generateTotpSecret()),
      uid,
    ]);
    const code = 'cafebabecafebabe';
    await execute('INSERT INTO mfa_backup_codes (id, user_id, code_hash) VALUES (?, ?, ?)', [
      uuidv4(),
      uid,
      hashBackupCodeForStorage(code),
    ]);

    const results = await Promise.all([tryConsumeBackupCode(uid, code), tryConsumeBackupCode(uid, code)]);
    assert.strictEqual(results.filter(Boolean).length, 1);
  });

  it('JWT with pur mfa_pending is not an access token shape (explicit reject in strategy)', () => {
    const token = jwt.sign(
      { sub: uuidv4(), pur: MFA_PENDING_PURPOSE },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: 60 }
    );
    const decoded = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as any;
    assert.strictEqual(decoded.pur, 'mfa_pending');
    assert.strictEqual(decoded.id, undefined);
  });
});
