import { defineConfig } from "vitest/config";
import { allureReporters } from "../../scripts/allure-vitest.ts";

export default defineConfig({
  test: {
    setupFiles: ["allure-vitest/setup"],
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: ["src/**/*.integration.spec.ts"],
    reporters: ["default", ...allureReporters("unit", "marketing")],
  },
});
