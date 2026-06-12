import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.ts";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.spec.ts"],
    testTimeout: 120_000,
    reporters: ["default", ...reportPortalReporters("integration")],
  },
});
