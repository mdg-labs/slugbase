import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, SUBPROCESS_TIMEOUT_MS } from "./run.ts";

// Behind PgBouncer in transaction mode a session-level advisory lock belongs to
// whichever server connection the pooler happened to give the statement, so it
// can be taken on one and released on another, or outlive the request that took
// it (doc 01 section 9.2). The application therefore takes advisory locks only
// through pg-boss or as `pg_advisory_xact_lock`. The `migrate` command is the
// one product path that holds a session lock, on a direct connection as the
// migrator, and the test harness holds its own as the superuser.

const EXEMPT = ["packages/db/src/migrate.ts", "packages/server/src/migrate/pgboss.ts", "packages/db/src/testing.ts"];

// Every advisory function of PostgreSQL except the transaction-level ones
// (`pg_advisory_xact_lock*`, `pg_try_advisory_xact_lock*`). The match is on the
// name's prefix and is case-insensitive, so it also reads a name that is built
// up from `pg_advisory_` and a format specifier, and a schema-qualified call.
const SESSION_ADVISORY_LOCK = /\bpg_(?:try_)?advisory_(?!xact_)/i;

describe("session-level advisory locks", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
  // Every file under the scanned paths, tracked or untracked and not ignored. The inputs of `@slugbase/tooling#test:unit` in turbo.json
  // list the same two globs, so a change to any of these files changes the task hash.
  function sourceFiles(): string[] {
    const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages/*/src/**", "packages/db/src/sql/**"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (listed.status !== 0) {
      throw new Error(`git ls-files failed: ${listed.stderr}`);
    }
    return [...new Set(listed.stdout.split("\n").filter((file) => file !== ""))];
  }

  const holders = (files: readonly string[]): string[] => files.filter((file) => SESSION_ADVISORY_LOCK.test(readFileSync(resolve(ROOT, file), "utf8")));

  it("recognises every session-level function and no transaction-level one", () => {
    for (const name of [
      "pg_advisory_lock",
      "pg_advisory_lock_shared",
      "pg_try_advisory_lock",
      "pg_try_advisory_lock_shared",
      "pg_advisory_unlock",
      "pg_advisory_unlock_shared",
      "pg_advisory_unlock_all",
      "PG_ADVISORY_LOCK",
      "pg_catalog.pg_advisory_lock",
      "pg_advisory_%s",
    ]) {
      expect(SESSION_ADVISORY_LOCK.test(`SELECT ${name}(hashtext('k'))`), name).toBe(true);
    }
    for (const name of ["pg_advisory_xact_lock", "pg_advisory_xact_lock_shared", "pg_try_advisory_xact_lock", "pg_try_advisory_xact_lock_shared", "PG_ADVISORY_XACT_LOCK"]) {
      expect(SESSION_ADVISORY_LOCK.test(`SELECT ${name}(hashtext('k'))`), name).toBe(false);
    }
  });

  it("takes none in packages/*/src and packages/db/src/sql, apart from migrate and the test harness", () => {
    const files = sourceFiles();
    // The sweep reads the sources and not an empty list.
    expect(files).toContain("packages/db/src/sql/120-setup.sql");
    expect(files).toContain("packages/db/src/tenant.ts");
    expect(holders(files.filter((file) => !EXEMPT.includes(file)))).toEqual([]);
  });

  it("keeps every exemption in use", () => {
    expect(holders(EXEMPT).sort()).toEqual([...EXEMPT].sort());
  });
});
