import type { FullConfig } from '@playwright/test';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const WORKER_COUNT = 8;

export interface WorkerCredentials {
  email: string;
  password: string;
  name: string;
}

async function seedServerOnboardingComplete(
  apiUrl: string,
  cred: WorkerCredentials,
): Promise<void> {
  const loginRes = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cred.email, password: cred.password }),
  });
  if (!loginRes.ok) {
    const body = await loginRes.text();
    throw new Error(
      `[global-setup] Login failed for ${cred.email}: ${loginRes.status} ${body}`,
    );
  }

  const cookies = loginRes.headers.getSetCookie().map((header) => {
    const nameValue = header.split(';')[0] ?? '';
    const eqIdx = nameValue.indexOf('=');
    return eqIdx === -1
      ? null
      : { name: nameValue.slice(0, eqIdx), value: nameValue.slice(eqIdx + 1) };
  }).filter(Boolean) as Array<{ name: string; value: string }>;

  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  const csrfRes = await fetch(`${apiUrl}/auth/csrf-token`, {
    headers: { Cookie: cookieHeader },
  });
  if (!csrfRes.ok) {
    throw new Error(
      `[global-setup] CSRF fetch failed for ${cred.email}: ${csrfRes.status}`,
    );
  }
  const csrfData = (await csrfRes.json()) as { csrfToken: string };
  for (const header of csrfRes.headers.getSetCookie()) {
    const nameValue = header.split(';')[0] ?? '';
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx !== -1) {
      cookies.push({
        name: nameValue.slice(0, eqIdx),
        value: nameValue.slice(eqIdx + 1),
      });
    }
  }

  const prefsRes = await fetch(`${apiUrl}/auth/account/preferences`, {
    method: 'PATCH',
    headers: {
      Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      'Content-Type': 'application/json',
      'x-csrf-token': csrfData.csrfToken,
    },
    body: JSON.stringify({ onboardingCompleted: true }),
  });
  if (!prefsRes.ok) {
    const body = await prefsRes.text();
    throw new Error(
      `[global-setup] Onboarding preference seed failed for ${cred.email}: ${prefsRes.status} ${body}`,
    );
  }
}

async function seedUsersOnboarding(apiUrl: string, users: WorkerCredentials[]) {
  for (const cred of users) {
    await seedServerOnboardingComplete(apiUrl, cred);
  }
}

/**
 * Global setup for e2e tests.
 *
 * 1. Seeds server-side onboarding completion for worker users via
 *    PATCH /auth/account/preferences (and keeps localStorage cache for tests).
 * 2. Registers N worker-scoped users for full test isolation.
 *    Writes credentials to `e2e/.worker-credentials.json`.
 * 3. For self-hosted runs, registers worker users via public registration
 *    (PUBLIC_REGISTRATION=true on the e2e container).
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

  const credentialsPath = resolve(
    process.cwd(),
    'e2e',
    '.worker-credentials.json',
  );

  const baseURL = process.env.E2E_BASE_URL_SELF_HOSTED;

  // ── Self-hosted: bootstrap via public registration (e2e container) ───
  if (baseURL) {
    console.log(
      `[global-setup] Registering ${WORKER_COUNT} self-hosted worker users at ${baseURL} …`,
    );

    const credentials: WorkerCredentials[] = [];

    for (let i = 0; i < WORKER_COUNT; i++) {
      const cred: WorkerCredentials = {
        email: `e2e-worker-${i}@slugbase.test`,
        password: 'e2e-test-password',
        name: `E2E Worker ${i}`,
      };

      const res = await fetch(`${baseURL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cred),
      });

      if (res.ok || res.status === 409) {
        credentials.push(cred);
      } else {
        const body = await res.text();
        throw new Error(
          `[global-setup] Self-hosted worker ${i} registration failed: ${res.status} ${body}`,
        );
      }
    }

    writeFileSync(
      credentialsPath,
      JSON.stringify(credentials, null, 2),
    );
    await seedUsersOnboarding(baseURL, credentials);
    console.log(
      `[global-setup] Wrote ${credentials.length} self-hosted worker credentials to ${credentialsPath}`,
    );
    return;
  }

  const apiUrl =
    process.env.E2E_BASE_URL_API ?? 'http://localhost:4001';

  // Always re-register worker users — the e2e script creates a fresh ephemeral
  // Postgres on every run, so any previously cached credentials are invalid.
  // Registration is idempotent (409 = already exists) so re-running is safe.
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
  await seedUsersOnboarding(apiUrl, [legacyUser, ...credentials]);
  console.log(
    `[global-setup] Wrote ${credentials.length} worker credentials to ${credentialsPath}`,
  );
}
