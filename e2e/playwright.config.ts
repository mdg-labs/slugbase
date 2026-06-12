import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  allurePlaywrightReporter,
  detectPlaywrightEdition,
} from '../scripts/allure-playwright.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CI = Boolean(process.env.CI);

const E2E_BASE_URL_API = process.env.E2E_BASE_URL_API ?? 'http://localhost:4001';
const E2E_BASE_URL_WEB = process.env.E2E_BASE_URL_WEB ?? 'http://localhost:4002';
const E2E_BASE_URL_MARKETING = process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

const ONBOARDING_STORAGE_STATE = resolve(__dirname, '.onboarding-storage-state.json');

/** Plan-gating and Stripe billing paths — valid only on the hosted VITE_BILLING_ENABLED build (#358). */
const HOSTED_ONLY_SPECS = [
  '**/settings/entitlement-gates.spec.ts',
  '**/entitlements/free-cap.spec.ts',
  '**/sharing/share-dialog.spec.ts',
  '**/sharing/scope-filters.spec.ts',
  '**/billing/**',
] as const;

/** Self-hosted operator surfaces — plan gates off, BYO admin panels (#357). */
const SELF_HOSTED_ONLY_SPECS = [
  '**/auth/setup.spec.ts',
  '**/settings/self-hosted-operator-settings.spec.ts',
] as const;

// ── Build the reporter list ─────────────────────────────────────────────────
// Playwright's ReporterDescription is `[string, object?]`.  We build it
// explicitly so the type checker is happy.
const reporters: ReporterDescription[] = [['list']];

// When e2e.sh runs both modes, it sets this env so we get a parseable JSON
// report per mode for the end-of-run summary table.
if (process.env.E2E_JSON_REPORT_PATH) {
  reporters.push(['json', { outputFile: process.env.E2E_JSON_REPORT_PATH }]);
}

// Allure: one results dir per Playwright project run (edition from --project).
// e2e.sh invokes hosted and self-hosted separately.
const edition = detectPlaywrightEdition();
if (edition) {
  reporters.push(...allurePlaywrightReporter(edition));
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
      testIgnore: [...SELF_HOSTED_ONLY_SPECS],
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
      // Marketing is a separate Cloudflare Worker; plan-gating specs need hosted billing build.
      testIgnore: ['**/marketing/**', ...HOSTED_ONLY_SPECS],
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
