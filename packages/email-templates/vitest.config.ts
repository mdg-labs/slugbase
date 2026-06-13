import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.ts";

export default defineConfig({
  test: {
    setupFiles: ["@reportportal/agent-js-vitest/setup"],
    include: ["src/**/*.spec.ts"],
    reporters: ["default", ...reportPortalReporters("unit", "email-templates")],
  },
});
