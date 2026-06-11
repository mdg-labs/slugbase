import { defineConfig, devices } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CI = Boolean(process.env.CI);

const E2E_BASE_URL_API = process.env.E2E_BASE_URL_API ?? 'http://localhost:4001';
const E2E_BASE_URL_WEB = process.env.E2E_BASE_URL_WEB ?? 'http://localhost:4002';
const E2E_BASE_URL_MARKETING = process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

const E2E_PORT_API = process.env.E2E_PORT_API ? Number(process.env.E2E_PORT_API) : 4001;
const E2E_PORT_WEB = process.env.E2E_PORT_WEB ? Number(process.env.E2E_PORT_WEB) : 4002;
const E2E_PORT_MKTG = process.env.E2E_PORT_MKTG ? Number(process.env.E2E_PORT_MKTG) : 4003;

interface NeetoPlaydashReporterConfig {
  ciBuildId?: string;
  apiKey?: string;
  projectKey?: string;
}

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 4 : undefined,

  reporter: [
    ['list'],
    // When e2e.sh runs both modes, it sets this path so we get a parseable
    // JSON report per mode for the end-of-run summary table.
    ...(process.env.E2E_JSON_REPORT_PATH
      ? [['json', { outputFile: process.env.E2E_JSON_REPORT_PATH }]]
      : []),
  ],

  use: {
    trace: 'on-first-retry',
    video: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'hosted',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: E2E_BASE_URL_WEB,
        extraHTTPHeaders: {
          'X-E2E-Base-URL-API': E2E_BASE_URL_API,
          'X-E2E-Base-URL-Marketing': E2E_BASE_URL_MARKETING,
        },
      },
      // Per-project reporter: hosted mode reports to its own Neeto Playdash project
      reporter: [
        ['list'],
        // JSON report for end-of-run summary (path set by scripts/e2e.sh per mode)
        ...(process.env.E2E_JSON_REPORT_PATH
          ? [['json', { outputFile: process.env.E2E_JSON_REPORT_PATH }]]
          : []),
        ...(CI
          ? [
              [
                '@bigbinary/neeto-playwright-reporter',
                {
                  ciBuildId: process.env.GITHUB_RUN_ID ?? 'local-run',
                  apiKey: process.env.NEETO_PLAYDASH_API_KEY_HOSTED ?? '',
                  projectKey: process.env.NEETO_PLAYDASH_PROJECT_KEY_HOSTED ?? '',
                } satisfies NeetoPlaydashReporterConfig,
              ],
            ]
          : []),
      ],
      // For hosted mode, services are started manually by scripts/e2e.sh (like CI)
      // Playwright's webServer is unreliable with multi-process setups — use undefined.
      webServer: undefined,
    },
    {
      name: 'self-hosted',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.E2E_BASE_URL_SELF_HOSTED ?? 'http://localhost:3000',
        extraHTTPHeaders: {
          'X-E2E-Base-URL-API': process.env.E2E_BASE_URL_SELF_HOSTED ?? 'http://localhost:3000',
        },
      },
      // Self-hosted mode: the combined Docker container is started by scripts/e2e.sh
      webServer: undefined,
      // Per-project reporter: self-hosted mode reports to its own Neeto Playdash project
      reporter: [
        ['list'],
        // JSON report for end-of-run summary (path set by scripts/e2e.sh per mode)
        ...(process.env.E2E_JSON_REPORT_PATH
          ? [['json', { outputFile: process.env.E2E_JSON_REPORT_PATH }]]
          : []),
        ...(CI
          ? [
              [
                '@bigbinary/neeto-playwright-reporter',
                {
                  ciBuildId: process.env.GITHUB_RUN_ID ?? 'local-run',
                  apiKey: process.env.NEETO_PLAYDASH_API_KEY_SELF_HOSTED ?? '',
                  projectKey: process.env.NEETO_PLAYDASH_PROJECT_KEY_SELF_HOSTED ?? '',
                } satisfies NeetoPlaydashReporterConfig,
              ],
            ]
          : []),
      ],
    },
  ],
});