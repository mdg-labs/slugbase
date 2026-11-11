import { defineConfig } from "@playwright/test";

// The configuration of the no-egress drill (e2e/no-egress.spec.ts), which `node run-tests.ts no-egress` uses. Like the other drills' it
// starts a stack of its own and talks to it over HTTP and docker compose, so it needs no browser, no TLS proxy, no session and no stack from
// e2e/with-stack.sh. It is not part of a run of `pnpm test:e2e` without arguments: it idles for minutes by design, and needs the image of the
// commit under test (SLUGBASE_IMAGE), as the `no-egress` job of e2e.yml sets it. Its output goes below the directories of the journeys'
// configuration (playwright.config.ts), which a run of the journeys empties first.
const CI = process.env.CI !== undefined && process.env.CI !== "";

export default defineConfig({
  testDir: ".",
  testMatch: /no-egress\.spec\.ts/,
  outputDir: "./test-results/no-egress",
  workers: 1,
  forbidOnly: CI,
  retries: 0,
  // The stack, the wait before the save, the wait after it and the control that follows.
  globalTimeout: 45 * 60_000,
  timeout: 30 * 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report/no-egress" }]] : [["list"]],
});
