/**
 * Idempotently inserts the standard E2E email/password user when missing.
 * Used by scripts/seed-e2e.ts (CLI) and optionally at server startup (SLUGBASE_E2E_SEED=1).
 * Requires initDatabase() to have run first.
 */
import { queryOne, execute } from '../db/index.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

const E2E_EMAIL = () => process.env.E2E_TEST_USER_EMAIL || 'e2e@test.local';
const E2E_PASSWORD = () => process.env.E2E_TEST_USER_PASSWORD || 'TestPassword123!';
const E2E_NAME = 'E2E Test';
const E2E_USER_KEY = 'e2e-test-key';

export async function ensureE2eUser(): Promise<void> {
  const email = E2E_EMAIL();
  const password = E2E_PASSWORD();
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    return;
  }
  const id = uuidv4();
  const hash = await bcrypt.hash(password, 10);
  await execute(
    `INSERT INTO users (id, email, name, user_key, password_hash, is_admin, email_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, email, E2E_NAME, E2E_USER_KEY, hash, 1, 1]
  );
  console.log('E2E user created:', email);
}
