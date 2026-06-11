import type { FullConfig } from '@playwright/test';

/**
 * Global setup for self-hosted e2e tests.
 * Calls POST /setup/complete to bootstrap the admin user + workspace
 * on a fresh database before any tests run.
 */
export default async function globalSetup(config: FullConfig) {
  // Only runs when self-hosted mode is active (env var set by e2e.sh)
  const baseURL = process.env.E2E_BASE_URL_SELF_HOSTED;
  if (!baseURL) {
    console.log('[global-setup] Skipping — not a self-hosted run');
    return;
  }

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
    // 409 = setup already completed — fine for repeated runs
    if (res.status === 409) {
      console.log('[global-setup] Setup already completed — skipping');
      return;
    }
    const body = await res.text();
    throw new Error(
      `[global-setup] Self-hosted bootstrap failed: ${res.status} ${body}`,
    );
  }

  console.log('[global-setup] Self-hosted bootstrap complete');
}
