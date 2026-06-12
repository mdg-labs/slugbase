import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.ts";

export default defineConfig({
  test: {
    include: ["test/**/*.e2e-spec.ts"],
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
    reporters: ["default", ...reportPortalReporters("integration")],
  },
});
