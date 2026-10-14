import { defineConfig, devices } from "@playwright/test";
import { appOrigin, STORAGE_STATE } from "./support/environment.ts";

// The address of a started stack and the origin it is configured with, from the
// environment: `bash e2e/with-stack.sh pnpm test:e2e` starts one and sets them
// (E2E_BASE_URL, E2E_APP_ORIGIN, the TLS key and certificate and the setup token,
// see e2e/global-setup.ts); against a stack of your own, set them yourself. They are
// variables of this test harness, not keys of the application.
const baseURL = appOrigin();

const CI = process.env.CI !== undefined && process.env.CI !== "";

// The journeys run against the built image (doc 08 section 5.1), in the three
// engines the smoke journey covers. Traces, videos and screenshots of a failed test
// are kept in test-results/, which the workflow uploads. Every journey starts from
// the session that the global setup signed in; a journey of a visitor without one
// starts from an empty state of its own (`test.use({ storageState })`).
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: CI,
  retries: 0,
  globalTimeout: 10 * 60_000,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : [["list"]],
  use: {
    baseURL,
    // The TLS proxy of the global setup serves a self-signed certificate.
    ignoreHTTPSErrors: true,
    storageState: STORAGE_STATE,
    locale: "en-US",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
