import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.js";

export default defineConfig({
  test: {
    setupFiles: ["@reportportal/agent-js-vitest/setup"],
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: ["src/**/*.integration.spec.ts"],
    reporters: ["default", ...reportPortalReporters("unit", "marketing")],
  },
});
