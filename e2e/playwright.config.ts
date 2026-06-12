import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CI = Boolean(process.env.CI);

const E2E_BASE_URL_API = process.env.E2E_BASE_URL_API ?? 'http://localhost:4001';
const E2E_BASE_URL_WEB = process.env.E2E_BASE_URL_WEB ?? 'http://localhost:4002';
const E2E_BASE_URL_MARKETING = process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

const ONBOARDING_STORAGE_STATE = resolve(__dirname, '.onboarding-storage-state.json');

// ── Build the reporter list ─────────────────────────────────────────────────
// Playwright's ReporterDescription is `[string, object?]`.  We build it
// explicitly so the type checker is happy.
const reporters: ReporterDescription[] = [['list']];

// When e2e.sh runs both modes, it sets this env so we get a parseable JSON
// report per mode for the end-of-run summary table.
if (process.env.E2E_JSON_REPORT_PATH) {
  reporters.push(['json', { outputFile: process.env.E2E_JSON_REPORT_PATH }]);
}

// In CI, add the Neeto Playdash reporter (single entry — both projects write
// to the same JSON file, so the top-level reporter is sufficient).
if (CI) {
  reporters.push([
    '@bigbinary/neeto-playwright-reporter',
    {
      ciBuildId: process.env.GITHUB_RUN_ID ?? 'local-run',
      apiKey: process.env.NEETO_PLAYDASH_API_KEY_HOSTED ?? '',
      projectKey: process.env.NEETO_PLAYDASH_PROJECT_KEY_HOSTED ?? '',
    },
  ]);
}

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 4 : undefined,

  reporter: reporters,

  use: {
    trace: 'on-first-retry',
    video: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'hosted',
      // Self-hosted setup flow doesn't apply to hosted (has pre-seeded admin)
      testIgnore: ['**/auth/setup.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: E2E_BASE_URL_WEB,
        storageState: ONBOARDING_STORAGE_STATE,
        extraHTTPHeaders: {
          'X-E2E-Base-URL-API': E2E_BASE_URL_API,
          'X-E2E-Base-URL-Marketing': E2E_BASE_URL_MARKETING,
        },
      },
    },
    {
      name: 'self-hosted',
      // Self-hosted does not serve the marketing site (it's a separate Cloudflare Worker)
      testIgnore: ['**/marketing/**'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.E2E_BASE_URL_SELF_HOSTED ?? 'http://localhost:3000',
        storageState: ONBOARDING_STORAGE_STATE,
        extraHTTPHeaders: {
          'X-E2E-Base-URL-API': process.env.E2E_BASE_URL_SELF_HOSTED ?? 'http://localhost:3000',
        },
      },
    },
  ],
});
