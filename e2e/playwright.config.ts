import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CI = Boolean(process.env.CI);

const E2E_BASE_URL_API = process.env.E2E_BASE_URL_API ?? 'http://localhost:4001';
const E2E_BASE_URL_WEB = process.env.E2E_BASE_URL_WEB ?? 'http://localhost:4002';

const ONBOARDING_STORAGE_STATE = resolve(__dirname, '.onboarding-storage-state.json');

const reporters: ReporterDescription[] = [['list']];

if (process.env.E2E_JSON_REPORT_PATH) {
  reporters.push(['json', { outputFile: process.env.E2E_JSON_REPORT_PATH }]);
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
      name: 'ce',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: E2E_BASE_URL_WEB,
        storageState: ONBOARDING_STORAGE_STATE,
        extraHTTPHeaders: {
          'X-E2E-Base-URL-API': E2E_BASE_URL_API,
        },
      },
    },
  ],
});
