import { defineConfig } from "@playwright/test";

// The configuration of the upgrade drill (e2e/upgrade-drill.spec.ts), which `node run-tests.ts upgrade-drill` uses. Like the
// restore drill's (restore-drill.config.ts) it starts stacks of its own and talks to them over HTTP and docker compose, so it
// needs no browser, no TLS proxy, no session and no stack from e2e/with-stack.sh. It is not part of a run of `pnpm test:e2e`
// without arguments: it pulls the release candidate image from the registry and needs the image of the commit under test and
// its commit (SLUGBASE_IMAGE and BUILD_COMMIT), which the `upgrade-drill` job of e2e.yml sets. Its output goes below the
// directories of the journeys' configuration (playwright.config.ts), which a run of the journeys empties first.
const CI = process.env.CI !== undefined && process.env.CI !== "";

export default defineConfig({
  testDir: ".",
  testMatch: /upgrade-drill\.spec\.ts/,
  outputDir: "./test-results/upgrade-drill",
  workers: 1,
  forbidOnly: CI,
  retries: 0,
  // Two stacks, each started, seeded and upgraded in turn.
  globalTimeout: 45 * 60_000,
  timeout: 15 * 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report/upgrade-drill" }]] : [["list"]],
});
