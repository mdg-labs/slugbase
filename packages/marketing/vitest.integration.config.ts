import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.js";

export default defineConfig({
  test: {
    setupFiles: ["@reportportal/agent-js-vitest/setup"],
    environment: "node",
    include: ["src/**/*.integration.spec.ts"],
    testTimeout: 120_000,
    reporters: ["default", ...reportPortalReporters("integration", "marketing")],
  },
});
