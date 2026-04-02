import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';

const neetoPlaywrightReporterConfig = {
  ciBuildId:
    process.env.NEETO_CI_BUILD_ID ||
    process.env.GITHUB_RUN_ID ||
    `local-${Date.now()}`,
  apiKey: process.env.NEETO_PLAYWRIGHT_REPORTER_API_KEY || '',
  projectKey: 'R3AURUCoxPT5hc5o2wgLypax',
};

const reporters: (['list'] | ['github'] | [string, Record<string, unknown>])[] = [
  process.env.CI ? ['github'] : ['list'],
];
if (neetoPlaywrightReporterConfig.apiKey) {
  reporters.push(['@bigbinary/neeto-playwright-reporter', neetoPlaywrightReporterConfig]);
}

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: reporters,
  use: {
    baseURL,
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'authenticated',
      testIgnore: ['**/auth.spec.ts', '**/password-reset.spec.ts', '**/guest-routing.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'unauthenticated',
      testMatch: /(auth|password-reset|guest-routing)\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  outputDir: 'e2e/test-results',
});
