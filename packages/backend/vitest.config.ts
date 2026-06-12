import { defineConfig } from "vitest/config";
import { allureReporters } from "../../scripts/allure-vitest.ts";

export default defineConfig({
  test: {
    setupFiles: ["allure-vitest/setup"],
    include: ["src/**/*.spec.ts"],
    fileParallelism: false,
    reporters: ["default", ...allureReporters("unit", "backend")],
  },
});
