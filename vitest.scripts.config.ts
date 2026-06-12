import { defineConfig } from "vitest/config";
import { allureReporters } from "./scripts/allure-vitest.ts";

export default defineConfig({
  test: {
    setupFiles: ["allure-vitest/setup"],
    include: ["scripts/**/*.spec.mjs"],
    reporters: ["default", ...allureReporters("unit", "scripts")],
  },
});
