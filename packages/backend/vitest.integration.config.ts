import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.js";

export default defineConfig({
  test: {
    setupFiles: ["@reportportal/agent-js-vitest/setup"],
    include: ["test/**/*.e2e-spec.ts"],
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
    reporters: ["default", ...reportPortalReporters("integration", "backend")],
  },
});
