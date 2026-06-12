import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.ts";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: ["src/**/*.integration.spec.ts"],
    reporters: ["default", ...reportPortalReporters("unit")],
  },
});
