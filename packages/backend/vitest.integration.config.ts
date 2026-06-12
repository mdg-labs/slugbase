import { defineConfig } from "vitest/config";
import { allureReporters } from "../../scripts/allure-vitest.ts";

export default defineConfig({
  test: {
    setupFiles: ["allure-vitest/setup"],
    include: ["test/**/*.e2e-spec.ts"],
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
    reporters: ["default", ...allureReporters("integration", "backend")],
  },
});
