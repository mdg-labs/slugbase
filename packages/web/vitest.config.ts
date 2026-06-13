import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.js";

export default defineConfig({
  test: {
    setupFiles: ["@reportportal/agent-js-vitest/setup"],
    environment: "happy-dom",
    include: ["app/**/*.spec.ts", "app/**/*.spec.tsx"],
    passWithNoTests: true,
    reporters: ["default", ...reportPortalReporters("unit", "web")],
  },
});
