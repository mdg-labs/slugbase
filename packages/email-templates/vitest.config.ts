import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.ts";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    reporters: ["default", ...reportPortalReporters("unit")],
  },
});
