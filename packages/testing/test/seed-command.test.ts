import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";

// `pnpm db:seed` end to end for the cases that must not reach a database: the command is started the way the package
// script starts it, with a PATH that has no psql, so a run that got past the guard would fail on that instead.

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

function run(env: Record<string, string>) {
  return spawnSync(process.execPath, ["scripts/seed.ts"], { cwd: PACKAGE, env: { PATH: "/nonexistent", ...env }, encoding: "utf8", timeout: 20_000 });
}

describe("pnpm db:seed", () => {
  it("refuses a database that is not the development one, and prints no password", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const result = run({
      DATABASE_URL: "postgres://slugbase_app:slugbase_app_dev_only@db.internal:54329/slugbase_dev",
      DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:slugbase_migrator_dev_only@db.internal:54329/slugbase_dev",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("db:seed: refused:");
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("slugbase_migrator_dev_only");
  });

  it("refuses when only the migrator URL points elsewhere", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const result = run({
      DATABASE_URL: "postgres://slugbase_app:slugbase_app_dev_only@127.0.0.1:54329/slugbase_dev",
      DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:slugbase_migrator_dev_only@127.0.0.1:5432/slugbase_dev",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("db:seed: refused:");
  });

  it("refuses without a configuration, whatever libpq would pick up from the environment", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const result = run({ PGHOST: "db.internal", PGDATABASE: "production" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is not set");
  });

  it("stops at psql, not before, when the target is the development database", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
    const result = run({
      DATABASE_URL: "postgres://slugbase_app:slugbase_app_dev_only@localhost:54329/slugbase_dev",
      DATABASE_MIGRATE_URL: "postgres://slugbase_migrator:slugbase_migrator_dev_only@localhost:54329/slugbase_dev",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not run psql");
    expect(result.stdout).toBe("");
  });
});
