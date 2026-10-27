import { mergeConfig } from "vitest/config";
import { defineSlugbaseConfig } from "../../vitest.shared.ts";

// Every integration test file holds its own database and pools on the shared
// development Postgres, so the number of files at once bounds the connections a
// run holds (doc 08 section 1.2).
//
// The file that measures the 95th percentile of the search (doc 08 section 5.3)
// is a project of its own, `integration-quiet`, which the db package's
// `test:integration:quiet` script runs. The root `pnpm test:integration` runs
// that script only after `turbo run test:integration` has finished every
// package's suite, so that no other database-heavy file, of this package or of
// another, shares the machine with its timings. The `integration` project
// leaves it out.
const QUIET_FILES = ["test/search-plan.integration.test.ts"];

export default mergeConfig(defineSlugbaseConfig({ exclude: QUIET_FILES }), {
  test: {
    maxWorkers: 2,
    projects: [
      {
        extends: true,
        test: {
          name: "integration-quiet",
          include: QUIET_FILES,
          environment: "node",
          fileParallelism: false,
        },
      },
    ],
  },
});
