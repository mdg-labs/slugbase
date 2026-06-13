import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.js";

export default defineConfig({
  test: {
    setupFiles: ["@reportportal/agent-js-vitest/setup"],
    include: ["src/**/*.spec.ts"],
    fileParallelism: false,
    reporters: ["default", ...reportPortalReporters("unit", "backend")],
  },
});
