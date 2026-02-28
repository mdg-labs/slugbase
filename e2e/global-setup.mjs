/**
 * Playwright global setup: wait for app health, then seed the test user if E2E_DB_PATH is set.
 * The app must already be running (started with DB_PATH=$E2E_DB_PATH).
 * Plain ESM (.mjs) so Node runs it as native ES module and avoids "exports is not defined" in CI.
 */
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
const healthURL = `${baseURL.replace(/\/$/, '')}/api/health`;

async function waitForHealth(maxAttempts = 30, intervalMs = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(healthURL);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`App not ready at ${healthURL} after ${maxAttempts} attempts`);
}

async function seedDatabase() {
  const dbPath = process.env.E2E_DB_PATH;
  if (!dbPath) return;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, '..');
  const backendDir = join(repoRoot, 'backend');
  const result = spawnSync('npx', ['tsx', 'scripts/seed-e2e.ts'], {
    cwd: backendDir,
    env: { ...process.env, DB_PATH: dbPath },
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`Seed script failed with status ${result.status}`);
  }
}

export default async function globalSetup() {
  await waitForHealth();
  await seedDatabase();
}
