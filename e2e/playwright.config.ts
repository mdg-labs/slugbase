import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  detectPlaywrightEdition,
  reportPortalPlaywrightReporter,
} from "../scripts/reportportal-playwright.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CI = Boolean(process.env.CI);

const E2E_BASE_URL_API = process.env.E2E_BASE_URL_API ?? 'http://localhost:4001';
const E2E_BASE_URL_WEB = process.env.E2E_BASE_URL_WEB ?? 'http://localhost:4002';
const E2E_BASE_URL_MARKETING = process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

const ONBOARDING_STORAGE_STATE = resolve(__dirname, '.onboarding-storage-state.json');

/** Plan-gating and Stripe billing paths — valid only on the Cloud VITE_BILLING_ENABLED build (#358). */
const CLOUD_ONLY_SPECS = [
  '**/settings/entitlement-gates.spec.ts',
  '**/entitlements/free-cap.spec.ts',
  '**/sharing/share-dialog.spec.ts',
  '**/sharing/scope-filters.spec.ts',
  '**/sharing/compact-share-modal.spec.ts',
  '**/sharing/sharing-badge.spec.ts',
  '**/billing/**',
] as const;

/** CE operator surfaces — plan gates off, BYO admin panels (#357). */
const CE_ONLY_SPECS = [
  '**/auth/setup.spec.ts',
  '**/settings/ce-operator-settings.spec.ts',
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

// ReportPortal: one launch per Playwright project run (edition from --project).
// e2e.sh invokes cloud and ce separately; no-ops when REPORTPORTAL_* unset.
const edition = detectPlaywrightEdition();
if (edition) {
  reporters.push(...reportPortalPlaywrightReporter(edition));
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
      name: 'cloud',
      testIgnore: [...CE_ONLY_SPECS],
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
      name: 'ce',
      // Marketing is a separate Cloudflare Worker; plan-gating specs need Cloud billing build.
      // CE split topology: web SSR container + api container (e2e.sh sets both base URLs).
      testIgnore: ['**/marketing/**', ...CLOUD_ONLY_SPECS],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.E2E_BASE_URL_WEB ?? 'http://localhost:4002',
        storageState: ONBOARDING_STORAGE_STATE,
        extraHTTPHeaders: {
          'X-E2E-Base-URL-API': process.env.E2E_BASE_URL_API ?? 'http://localhost:4001',
        },
      },
    },
  ],
});
