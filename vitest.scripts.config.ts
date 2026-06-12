import { defineConfig } from "vitest/config";
import { reportPortalReporters } from "./scripts/reportportal-vitest.ts";

export default defineConfig({
  test: {
    include: ["scripts/**/*.spec.mjs"],
    reporters: ["default", ...reportPortalReporters("unit")],
  },
});
