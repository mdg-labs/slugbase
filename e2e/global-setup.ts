import type { FullConfig } from '@playwright/test';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const WORKER_COUNT = 8;

export interface WorkerCredentials {
  email: string;
  password: string;
  name: string;
}

/**
 * Global setup for e2e tests.
 *
 * 1. Seeds localStorage with `sb_onboarding_done` so the onboarding overlay
 *    does not intercept pointer events during tests.
 * 2. Registers N worker-scoped users for full test isolation.
 *    Writes credentials to `e2e/.worker-credentials.json`.
 * 3. For self-hosted runs, calls POST /setup/complete to bootstrap the admin
 *    user + workspace on a fresh database.
 */
export default async function globalSetup(config: FullConfig) {
  // ── Seed onboarding-done localStorage for ALL projects ──────────────
  const webUrl =
    process.env.E2E_BASE_URL_WEB ??
    process.env.E2E_BASE_URL_SELF_HOSTED ??
    'http://localhost:4002';
  const webOrigin = new URL(webUrl).origin;

  const storageStatePath = resolve(
    process.cwd(),
    'e2e',
    '.onboarding-storage-state.json',
  );

  writeFileSync(
    storageStatePath,
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: webOrigin,
          localStorage: [
            { name: 'sb_onboarding_done', value: 'true' },
          ],
        },
      ],
    }),
  );

  console.log(
    `[global-setup] Seeded onboarding localStorage for origin ${webOrigin}`,
  );

  // ── Self-hosted: bootstrap admin + workspace ────────────────────────
  const baseURL = process.env.E2E_BASE_URL_SELF_HOSTED;
  if (baseURL) {
    console.log(`[global-setup] Bootstrapping self-hosted at ${baseURL} …`);

    const res = await fetch(`${baseURL}/setup/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'e2e@slugbase.test',
        name: 'E2E Admin',
        password: 'e2e-test-password',
        workspaceName: 'E2E Workspace',
        workspaceSlug: 'e2e-workspace',
      }),
    });

    if (!res.ok) {
      if (res.status === 409) {
        console.log('[global-setup] Setup already completed — skipping');
      } else {
        const body = await res.text();
        throw new Error(
          `[global-setup] Self-hosted bootstrap failed: ${res.status} ${body}`,
        );
      }
    } else {
      console.log('[global-setup] Self-hosted bootstrap complete');
    }
  }

  // ── Register worker-scoped users for full test isolation ────────────
  // Skip for self-hosted runs — the setup/complete endpoint already creates
  // the admin user, and worker users need registration which may not be
  // available in self-hosted mode.
  if (baseURL) {
    console.log('[global-setup] Skipping worker user registration — self-hosted mode');
    return;
  }

  const apiUrl =
    process.env.E2E_BASE_URL_API ?? 'http://localhost:4001';

  const credentialsPath = resolve(
    process.cwd(),
    'e2e',
    '.worker-credentials.json',
  );

  // If credentials file already exists (e.g. from a previous partial run),
  // check if it has the right count and skip registration.
  if (existsSync(credentialsPath)) {
    try {
      const existing = JSON.parse(
        readFileSync(credentialsPath, 'utf-8'),
      ) as WorkerCredentials[];
      if (existing.length >= WORKER_COUNT) {
        console.log(
          `[global-setup] Worker credentials already exist (${existing.length} users) — skipping registration`,
        );
        return;
      }
    } catch {
      // Corrupted file — re-create
    }
  }

  console.log(
    `[global-setup] Registering ${WORKER_COUNT} worker users at ${apiUrl} …`,
  );

  const credentials: WorkerCredentials[] = [];

  // Also register the legacy shared user for backward compatibility
  const legacyUser: WorkerCredentials = {
    email: 'e2e@slugbase.test',
    password: 'e2e-test-password',
    name: 'E2E Test User',
  };

  // Register the legacy user first
  const legacyRes = await fetch(`${apiUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(legacyUser),
  });
  if (legacyRes.ok || legacyRes.status === 409) {
    console.log('[global-setup] Legacy user registered or already exists');
  } else {
    console.warn(
      `[global-setup] Legacy user registration returned ${legacyRes.status} — continuing`,
    );
  }

  // Register worker-scoped users
  for (let i = 0; i < WORKER_COUNT; i++) {
    const cred: WorkerCredentials = {
      email: `e2e-worker-${i}@slugbase.test`,
      password: 'e2e-test-password',
      name: `E2E Worker ${i}`,
    };

    const res = await fetch(`${apiUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cred),
    });

    if (res.ok || res.status === 409) {
      // 409 = already registered — that's fine, reuse the cred
      credentials.push(cred);
    } else {
      const body = await res.text();
      throw new Error(
        `[global-setup] Worker ${i} registration failed: ${res.status} ${body}`,
      );
    }
  }

  writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
  console.log(
    `[global-setup] Wrote ${credentials.length} worker credentials to ${credentialsPath}`,
  );
}
