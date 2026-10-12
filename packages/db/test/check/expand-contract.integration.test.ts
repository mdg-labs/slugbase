import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { GitPackage, releasedRepository, SECOND } from "./git-package.ts";

// `pnpm db:check` (scripts/db-check.ts) against a temporary git repository with
// a release tag: the contract marker travels from the environment of the
// command to the rule, and the rule's verdict decides the exit code. The other
// rules fail on such a repository (it holds no checksums or custom SQL), so
// only the lines of the expand-contract rule are judged here, plus the exit
// code of a run that fails on it.

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

function dbCheck(repository: GitPackage, marker: string | undefined): { stdout: string; stderr: string; status: number | null } {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  delete env["SLUGBASE_DB_CHECK_CONTRACT"];
  const result = spawnSync(process.execPath, [SCRIPT, "--package", repository.dir], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: marker === undefined ? env : { ...env, SLUGBASE_DB_CHECK_CONTRACT: marker },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

const verdict = (stdout: string): string[] => stdout.split("\n").filter((line) => line.includes("expand-contract"));

describe("pnpm db:check and the contract migration", () => {
  it("fails on a drop of a released column when the migration has a header but the run has no marker", () => {
    const { stdout, status } = dbCheck(pair(HEADER), undefined);
    expect(verdict(stdout)).toEqual([expect.stringContaining("FAIL  expand-contract: migrations/20260301000000_drop_legacy_title.sql: drops column bookmarks.legacy_title")]);
    expect(status).toBe(1);
  }, TIMEOUT_MS);

  it("fails when the marker is anything but true", () => {
    expect(verdict(dbCheck(pair(HEADER), "false").stdout)).toEqual([expect.stringContaining("FAIL  expand-contract")]);
  }, TIMEOUT_MS);

  it("fails on the marker without the header", () => {
    const { stdout } = dbCheck(pair(""), "true");
    expect(verdict(stdout)).toEqual([expect.stringContaining("has no contract header")]);
  }, TIMEOUT_MS);

  it("passes the rule with the header and SLUGBASE_DB_CHECK_CONTRACT=true", () => {
    const { stdout } = dbCheck(pair(HEADER), "true");
    expect(verdict(stdout)).toEqual(["db:check: ok    expand-contract"]);
  }, TIMEOUT_MS);

  it("reports a header-marked drop as awaiting the label on a push run, not as a failure", () => {
    const { stdout } = dbCheck(pair(HEADER), "pending");
    expect(verdict(stdout)).toEqual([
      expect.stringContaining("AWAIT expand-contract: migrations/20260301000000_drop_legacy_title.sql: drops column bookmarks.legacy_title"),
    ]);
    expect(stdout).not.toContain("FAIL  expand-contract");
  }, TIMEOUT_MS);

  it("still fails an unmarked drop on a push run, and exits 1", () => {
    const { stdout, status } = dbCheck(pair(""), "pending");
    expect(verdict(stdout)).toEqual([expect.stringContaining("FAIL  expand-contract: migrations/20260301000000_drop_legacy_title.sql: drops column")]);
    expect(verdict(stdout)[0]).toContain("has no contract header");
    expect(status).toBe(1);
  }, TIMEOUT_MS);

  it("still fails a drop with a malformed header on a push run", () => {
    const { stdout, status } = dbCheck(pair(`-- slugbase:contract expand=${SECOND}\n`), "pending");
    expect(verdict(stdout)).toEqual([expect.stringContaining("FAIL  expand-contract")]);
    expect(verdict(stdout)[0]).toContain("malformed contract header");
    expect(status).toBe(1);
  }, TIMEOUT_MS);

  it("exits 2 on a marker value it does not know, before it checks anything", () => {
    for (const marker of ["1", "TRUE", "", "pendng"]) {
      const { stdout, stderr, status } = dbCheck(pair(HEADER), marker);
      expect(status, marker).toBe(2);
      expect(stderr, marker).toContain("must be true, false or pending");
      expect(stdout, marker).toBe("");
    }
  }, TIMEOUT_MS);
});
