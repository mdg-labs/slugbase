import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e-spec.ts"],
    fileParallelism: false,
    globalSetup: ["./src/test/global-setup.ts"],
  },
});
