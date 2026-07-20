import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.e2e-spec.ts"],
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
  },
});
