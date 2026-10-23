import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { GitPackage, releasedRepository, SECOND } from "./git-package.ts";

// `pnpm db:check` (scripts/db-check.ts) against a temporary git repository with
// a release tag, with nothing in the environment to configure it: the rule's
// verdict on the migration file alone decides the exit code. The other rules
// fail on such a repository (it holds no checksums or custom SQL), so only the
// lines of the expand-contract rule are judged here, plus the exit code of a
// run that fails on it.

const TIMEOUT_MS = 180_000;
const SCRIPT = new URL("../../scripts/db-check.ts", import.meta.url).pathname;
const THIRD = "20260301000000_drop_legacy_title";
const HEADER = `-- slugbase:contract expand=${SECOND} release=1.1.0\n`;

const repositories: GitPackage[] = [];

afterAll(() => {
  for (const repository of repositories) {
    repository.remove();
  }
});

/** v1.0.0 holds bookmarks.legacy_title; v1.1.0 holds the expand migration; the contract migration is not committed. */
function pair(header: string): GitPackage {
  const repository = releasedRepository("v1.0.0");
  repositories.push(repository);
  repository.migration(SECOND, 'ALTER TABLE "bookmarks" ADD COLUMN "name" text;', [
    { name: "bookmarks", columns: ["id", "title", "legacy_title", "name"] },
  ]);
  repository.commit("expand");
  repository.tag("v1.1.0");
  repository.migration(THIRD, `${header}ALTER TABLE "bookmarks" DROP COLUMN "legacy_title";\n`, [
    { name: "bookmarks", columns: ["id", "title", "name"] },
  ]);
  return repository;
}

function dbCheck(repository: GitPackage): { stdout: string; stderr: string; status: number | null } {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const result = spawnSync(process.execPath, [SCRIPT, "--package", repository.dir], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

const verdict = (stdout: string): string[] => stdout.split("\n").filter((line) => line.includes("expand-contract"));

describe("pnpm db:check and the contract migration", () => {
  it("passes a drop of a released column when the migration carries a valid header", () => {
    const { stdout } = dbCheck(pair(HEADER));
    expect(verdict(stdout)).toEqual(["db:check: ok    expand-contract"]);
  }, TIMEOUT_MS);

  it("fails the same drop without a header, and exits 1", () => {
    const { stdout, status } = dbCheck(pair(""));
    expect(verdict(stdout)).toEqual([expect.stringContaining("FAIL  expand-contract: migrations/20260301000000_drop_legacy_title.sql: drops column bookmarks.legacy_title")]);
    expect(verdict(stdout)[0]).toContain("has no contract header");
    expect(stdout).not.toContain("AWAIT");
    expect(status).toBe(1);
  }, TIMEOUT_MS);

  it("fails a drop with a malformed header", () => {
    const { stdout, status } = dbCheck(pair(`-- slugbase:contract expand=${SECOND}\n`));
    expect(verdict(stdout)).toEqual([expect.stringContaining("FAIL  expand-contract")]);
    expect(verdict(stdout)[0]).toContain("malformed contract header");
    expect(status).toBe(1);
  }, TIMEOUT_MS);

  it("fails a drop whose header names a release that does not contain the expand migration", () => {
    const { stdout, status } = dbCheck(pair(`-- slugbase:contract expand=${SECOND} release=1.0.0\n`));
    expect(verdict(stdout)).toEqual([expect.stringContaining("FAIL  expand-contract")]);
    expect(status).toBe(1);
  }, TIMEOUT_MS);
});
