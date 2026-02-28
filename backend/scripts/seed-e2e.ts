/**
 * Seeds the e2e test user into the database. Run with the same DB_PATH as the running server.
 * Usage: DB_PATH=/path/to/e2e.sqlite JWT_SECRET=... ENCRYPTION_KEY=... npx tsx backend/scripts/seed-e2e.ts
 * (from repo root; or from backend/ with DB_PATH=../.e2e-db.sqlite)
 */
import '../src/load-env.js';
import { initDatabase, queryOne, execute } from '../src/db/index.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

const E2E_EMAIL = process.env.E2E_TEST_USER_EMAIL || 'e2e@test.local';
const E2E_PASSWORD = process.env.E2E_TEST_USER_PASSWORD || 'TestPassword123!';
const E2E_NAME = 'E2E Test';
const E2E_USER_KEY = 'e2e-test-key';

async function main() {
  await initDatabase();
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [E2E_EMAIL]);
  if (existing) {
    console.log('E2E user already exists:', E2E_EMAIL);
    process.exit(0);
  }
  const id = uuidv4();
  const hash = await bcrypt.hash(E2E_PASSWORD, 10);
  await execute(
    `INSERT INTO users (id, email, name, user_key, password_hash, is_admin, email_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, E2E_EMAIL, E2E_NAME, E2E_USER_KEY, hash, 1, 1]
  );
  console.log('E2E user created:', E2E_EMAIL);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
