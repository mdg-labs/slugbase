import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.ts";

export default defineConfig({
  test: {
    setupFiles: ["@reportportal/agent-js-vitest/setup"],
    environment: "happy-dom",
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
    reporters: ["default", ...reportPortalReporters("unit", "ui")],
  },
});
