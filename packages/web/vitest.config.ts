import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "../../scripts/reportportal-vitest.ts";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["app/**/*.spec.ts", "app/**/*.spec.tsx"],
    passWithNoTests: true,
    reporters: ["default", ...reportPortalReporters("unit")],
  },
});
