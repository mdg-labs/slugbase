import { defineConfig } from "@playwright/test";

// The configuration of the backup and restore drill (e2e/restore-drill.spec.ts), which `node run-tests.ts restore-drill` and a
// run of `pnpm test:e2e` without arguments use. The drill starts a stack of its own and talks to it over HTTP and docker compose,
// so it needs no browser, no TLS proxy, no session and no stack from e2e/with-stack.sh. Its output goes below the directories of
// the journeys' configuration (playwright.config.ts), which a run of the journeys empties first.
const CI = process.env.CI !== undefined && process.env.CI !== "";

export default defineConfig({
  testDir: ".",
  testMatch: /restore-drill\.spec\.ts/,
  outputDir: "./test-results/restore-drill",
  workers: 1,
  forbidOnly: CI,
  retries: 0,
  // The image may be built from the checkout, then two restores follow.
  globalTimeout: 45 * 60_000,
  timeout: 10 * 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report/restore-drill" }]] : [["list"]],
});
