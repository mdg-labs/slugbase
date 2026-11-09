import { defineConfig } from "@playwright/test";

// The configuration of the reverse proxy drill (e2e/reverse-proxy.spec.ts), which `node run-tests.ts reverse-proxy` and a run of
// `pnpm test:e2e` without arguments use. Like the backup and restore drill, it starts a stack of its own and talks to it over HTTP,
// docker and docker compose, so it needs no browser and no stack from e2e/with-stack.sh. Its output goes below the directories of the
// journeys' configuration (playwright.config.ts), which a run of the journeys empties first.
const CI = process.env.CI !== undefined && process.env.CI !== "";

export default defineConfig({
  testDir: ".",
  testMatch: /reverse-proxy\.spec\.ts/,
  outputDir: "./test-results/reverse-proxy",
  workers: 1,
  forbidOnly: CI,
  retries: 0,
  // The image may be built from the checkout, then each proxy and the wait for the sign-in bucket to refill follow.
  globalTimeout: 45 * 60_000,
  timeout: 10 * 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report/reverse-proxy" }]] : [["list"]],
});
