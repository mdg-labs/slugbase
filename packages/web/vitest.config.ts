import { defineConfig } from "vitest/config";
import { allureReporters } from "../../scripts/allure-vitest.ts";

export default defineConfig({
  test: {
    setupFiles: ["allure-vitest/setup"],
    environment: "happy-dom",
    include: ["app/**/*.spec.ts", "app/**/*.spec.tsx"],
    passWithNoTests: true,
    reporters: ["default", ...allureReporters("unit", "web")],
  },
});
