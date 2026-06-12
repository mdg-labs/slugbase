import { defineConfig } from "vitest/config";
import { allureReporters } from "../../scripts/allure-vitest.ts";

export default defineConfig({
  test: {
    setupFiles: ["allure-vitest/setup"],
    environment: "happy-dom",
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
    reporters: ["default", ...allureReporters("unit", "ui")],
  },
});
