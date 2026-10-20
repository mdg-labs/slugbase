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
// are kept in test-results/, which the workflow uploads. The first journey to run is
// the first-run setup (tests/first-run.setup.ts, the `setup` project): it claims the
// instance, signs the owner in and keeps the session as the state every other journey
// starts from, so the engines wait for it. A journey of a visitor without a session
// starts from an empty state of its own (`test.use({ storageState })`).
//
// The accounts journey (tests/accounts.spec.ts) invites, accepts and signs in with a
// second factor, one sign-in after the other, against the limits of sign-in attempts
// per client address that the stack keeps (10 a minute, doc 04 section 7). Three engines
// at once would share them, so it runs in Chromium alone, the engine of the long tail.
const SETUP = /.*\.setup\.ts/;
const ACCOUNTS = /accounts\.spec\.ts/;

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
    { name: "setup", testMatch: SETUP, use: { ...devices["Desktop Chrome"], storageState: { cookies: [], origins: [] } } },
    { name: "chromium", testIgnore: SETUP, dependencies: ["setup"], use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", testIgnore: [SETUP, ACCOUNTS], dependencies: ["setup"], use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", testIgnore: [SETUP, ACCOUNTS], dependencies: ["setup"], use: { ...devices["Desktop Safari"] } },
  ],
});
