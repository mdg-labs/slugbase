import { defineConfig, devices } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CI = Boolean(process.env.CI);

const E2E_BASE_URL_API = process.env.E2E_BASE_URL_API ?? 'http://localhost:4001';
const E2E_BASE_URL_WEB = process.env.E2E_BASE_URL_WEB ?? 'http://localhost:4002';
const E2E_BASE_URL_MARKETING = process.env.E2E_BASE_URL_MARKETING ?? 'http://localhost:4003';

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
    ...(CI
      ? [
          [
            '@bigbinary/neeto-playwright-reporter',
            {
              ciBuildId: process.env.GITHUB_RUN_ID ?? 'local-run',
              apiKey: process.env.NEETO_PLAYDASH_API_KEY ?? '',
              projectKey: process.env.NEETO_PLAYDASH_PROJECT_KEY ?? '',
            } satisfies NeetoPlaydashReporterConfig,
          ],
        ]
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
    },
  ],

  webServer: CI
    ? undefined
    : [
        {
          command: 'node packages/backend/dist/main.js',
          port: 4001,
          cwd: resolve(__dirname, '..'),
          reuseExistingServer: true,
          env: {
            PORT: '4001',
            SLUGBASE_E2E_MODE: 'true',
            SESSION_SECRET: 'e2e-test-session-secret-at-least-32-chars!!',
            ENCRYPTION_KEY: 'e2e-test-encryption-key-at-least-32-chars!!',
            APP_BASE_URL: 'http://localhost:4001',
            FRONTEND_ORIGIN: 'http://localhost:4002',
            ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
          },
        },
        {
          command: 'npx --yes react-router-serve build/server/index.js',
          port: 4002,
          cwd: resolve(__dirname, '../packages/web'),
          reuseExistingServer: true,
          env: {
            PORT: '4002',
          },
        },
        {
          command: 'npx --yes serve packages/marketing/dist -l 4003',
          port: 4003,
          cwd: resolve(__dirname, '..'),
          reuseExistingServer: true,
        },
      ],
});