import { mergeConfig } from "vitest/config";
import { defineSlugbaseConfig } from "../../vitest.shared.ts";

// Every integration test file holds its own database and pools on the shared
// development Postgres, so the number of files at once bounds the connections a
// run holds (doc 08 section 1.2).
export default mergeConfig(defineSlugbaseConfig(), { test: { maxWorkers: 2 } });
