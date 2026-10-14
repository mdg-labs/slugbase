import { defineConfig, devices } from "@playwright/test";

// The address of a started stack, from the environment: `bash e2e/with-stack.sh
// pnpm test:e2e` starts one and sets it; against a stack of your own, set it
// yourself. It is a variable of this test harness, not a key of the application.
const baseURL = process.env.E2E_BASE_URL;
if (baseURL === undefined || baseURL === "") {
  throw new Error(
    "E2E_BASE_URL is not set. Start a stack and set it to its address, or run `bash e2e/with-stack.sh pnpm test:e2e`.",
  );
}

const CI = process.env.CI !== undefined && process.env.CI !== "";

// The journeys run against the built image (doc 08 section 5.1), in the three
// engines the smoke journey covers. Traces, videos and screenshots of a failed test
// are kept in test-results/, which the workflow uploads.
export default defineConfig({
  testDir: "./tests",
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
