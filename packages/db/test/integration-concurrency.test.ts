import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The shared development Postgres of compose.dev.yml serves every checkout and
// scratch clone on the machine (doc 08 section 1.2). One `pnpm test:integration`
// run peaked at 38 connections above what the stack held before it with the
// bounds below; without them the file parallelism of the two largest packages
// alone reached the default limit of 100.
const MEASURED_RUN_PEAK = 38;
const SUPPORTED_CONCURRENT_RUNS = 3;
// The connections Postgres keeps back for superusers (superuser_reserved_connections).
const SUPERUSER_RESERVED = 3;
const MAX_FILES_AT_ONCE = 2;

const COMPOSE = new URL("../../../compose.dev.yml", import.meta.url);
const CONFIGS = [
  ["@slugbase/db", new URL("../vitest.config.ts", import.meta.url)],
  ["@slugbase/server", new URL("../../server/vitest.config.ts", import.meta.url)],
] as const;

const WORKSPACE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLUSTER_LOCK_KEY = /7_?354_?190_?025/;
// The one test file that names the key to look at who holds it in pg_locks, and takes none itself.
const LOCK_OBSERVER = "packages/db/test/harness-cluster-lock.integration.test.ts";

// The folders of test files in the packages and apps, as paths from the root.
function testFiles(): string[] {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(join(WORKSPACE_ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const folder = join(group, entry.name, "test");
        try {
          return readdirSync(join(WORKSPACE_ROOT, folder), { recursive: true, encoding: "utf8" })
            .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
            .map((file) => join(folder, file));
        } catch {
          return [];
        }
      }),
  );
}

describe("the integration runs the development Postgres serves at once", () => {
  it.each(CONFIGS)("bounds how many test files of %s run at once", (_name, file) => {
    const bound = /\bmaxWorkers:\s*(\d+)/.exec(readFileSync(file, "utf8"))?.[1];
    expect(bound).toBeDefined();
    expect(Number(bound)).toBeGreaterThanOrEqual(1);
    expect(Number(bound)).toBeLessThanOrEqual(MAX_FILES_AT_ONCE);
  });

  it("starts Postgres with room for the supported number of concurrent runs", () => {
    const compose = readFileSync(COMPOSE, "utf8");
    const limit = /"-c",\s*"max_connections=(\d+)"/.exec(compose)?.[1];
    expect(limit).toBeDefined();
    expect(Number(limit) - SUPERUSER_RESERVED).toBeGreaterThanOrEqual(SUPPORTED_CONCURRENT_RUNS * MEASURED_RUN_PEAK);
  });

  // A test file that took the cluster lock itself would hold it for its whole
  // run, and every test database of every run would wait for it (doc 08 section 3.2).
  it("leaves the cluster lock to the harness, which holds it exclusively only for a step of a test", () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(50);
    const holders = files.filter(
      (file) => file !== LOCK_OBSERVER && CLUSTER_LOCK_KEY.test(readFileSync(join(WORKSPACE_ROOT, file), "utf8")),
    );
    expect(holders).toEqual([]);
  });
});
