import { defineConfig } from "vitest/config";
import { allureReporters } from "../../scripts/allure-vitest.ts";

export default defineConfig({
  test: {
    setupFiles: ["allure-vitest/setup"],
    environment: "node",
    include: ["src/**/*.integration.spec.ts"],
    testTimeout: 120_000,
    reporters: ["default", ...allureReporters("integration", "marketing")],
  },
});
