/**
 * Seeds the e2e test user into the database. Run with the same DB_PATH as the running server.
 * Usage: DB_PATH=/path/to/e2e.sqlite JWT_SECRET=... ENCRYPTION_KEY=... npx tsx backend/scripts/seed-e2e.ts
 * (from repo root; or from backend/ with DB_PATH=../.e2e-db.sqlite)
 */
import '../src/load-env.js';
import { initDatabase, queryOne } from '../src/db/index.js';
import { ensureE2eUser } from '../src/e2e/ensure-e2e-user.js';

async function main() {
  await initDatabase();
  const email = process.env.E2E_TEST_USER_EMAIL || 'e2e@test.local';
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    console.log('E2E user already exists:', email);
    process.exit(0);
  }
  await ensureE2eUser();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
