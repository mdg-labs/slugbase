import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MigrationChain } from "../src/migrate.ts";
import { createTestDatabase, dropTestTemplate, testTemplateName } from "../src/testing.ts";

// The template name is a function of everything the template is built from
// (doc 08 section 3.2), and the harness refuses to create or drop a database
// outside its two name patterns. Neither needs a server.

const FIXTURE = new URL("./migrations/fixtures/restored/", import.meta.url).pathname;

const folders: string[] = [];

function chainCopy(name: string): MigrationChain {
  const folder = mkdtempSync(join(tmpdir(), "slugbase-tpl-"));
  folders.push(folder);
  cpSync(FIXTURE, folder, { recursive: true });
  return { name, folder, bookkeepingTable: `migrations_${name}` };
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("testTemplateName", () => {
  it("names the template slugbase_tpl_ followed by 32 hex digits", () => {
    expect(testTemplateName()).toMatch(/^slugbase_tpl_[0-9a-f]{32}$/);
  });

  it("is the same for the same chain list, wherever the chain folders are", () => {
    expect(testTemplateName([chainCopy("extra")])).toBe(testTemplateName([chainCopy("extra")]));
  });

  it("changes with the chain list", () => {
    const extra = chainCopy("extra");
    expect(testTemplateName([extra])).not.toBe(testTemplateName());
    expect(testTemplateName([extra, chainCopy("other")])).not.toBe(testTemplateName([extra]));
    expect(testTemplateName([chainCopy("renamed")])).not.toBe(testTemplateName([extra]));
  });

  it("changes with the order of the chains", () => {
    const first = chainCopy("first");
    const second = chainCopy("second");
    expect(testTemplateName([first, second])).not.toBe(testTemplateName([second, first]));
  });

  it("changes when a migration file of a chain changes", () => {
    const extra = chainCopy("extra");
    const before = testTemplateName([extra]);
    writeFileSync(join(extra.folder, "20300101000001_create_restored_target.sql"), "CREATE TABLE restored_target (b integer);\n");
    expect(testTemplateName([extra])).not.toBe(before);
  });

  it("changes when the journal of a chain changes", () => {
    const extra = chainCopy("extra");
    const before = testTemplateName([extra]);
    writeFileSync(join(extra.folder, "meta", "_journal.json"), '{"version":"7","dialect":"postgresql","entries":[]}\n');
    expect(testTemplateName([extra])).not.toBe(before);
  });
});

describe("the names the harness accepts", () => {
  it("refuses to drop a template that is not a slugbase_tpl_ database, before it connects", async () => {
    for (const name of ["slugbase_dev", "postgres", "template1", "test_0123456789abcdef", "slugbase_tpl_x", 'slugbase_tpl_0123456789abcdef0123456789abcdef"; DROP DATABASE slugbase_dev; --']) {
      await expect(dropTestTemplate(name, { serverUrl: "postgres://nobody:secret@127.0.0.1:1/none" })).rejects.toThrow(
        /slugbase_tpl_/,
      );
    }
  });

  it("refuses a server URL that is not a PostgreSQL URL, without echoing it", async () => {
    const error = await createTestDatabase({ serverUrl: "mysql://user:hunter2@localhost/db" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/SLUGBASE_TEST_PG_URL/);
    expect((error as Error).message).not.toContain("hunter2");
  });
});
