import { afterEach, describe, expect, it } from "vitest";
import { hashSqlFiles } from "../../scripts/migration-sql.ts";
import { checkRules, formatReport, runChecks } from "../../src/check/index.ts";
import { createPurgeRegistryRule, purgeRegistryRule } from "../../src/check/purge-registry.ts";
import type { Finding } from "../../src/check/types.ts";
import { workspacePurgeOrder } from "../../src/purge-registry.ts";
import { createTestDatabase, type TestDatabase } from "../../src/testing.ts";
import { PACKAGE } from "./package-copy.ts";

// The purge-registry rule (doc 05 section 7.2, doc 10 T1) against fixture tables in scratch databases cloned
// from the migration template: a tenant table the registry does not name, an entry that is no table, and an
// entry whose table the purge function has no statement for each fail it, and the shipped registry passes.

const HOOK_TIMEOUT_MS = 180_000;
const ID = "purge-registry";

const databases: TestDatabase[] = [];

async function scratch(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  databases.push(database);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.drop()));
}, HOOK_TIMEOUT_MS);

async function inspect(database: TestDatabase, registry: readonly string[]): Promise<readonly Finding[]> {
  return await createPurgeRegistryRule(registry).run({ packageDir: PACKAGE, sql: database.app, hashSqlFiles });
}

describe("the purge registry", () => {
  it("passes the shipped registry against the shipped chain, and is one of the rules of db:check", async () => {
    const database = await scratch();

    expect(await purgeRegistryRule.run({ packageDir: PACKAGE, sql: database.app, hashSqlFiles })).toEqual([]);
    expect(checkRules).toContain(purgeRegistryRule);
  }, HOOK_TIMEOUT_MS);

  it("fails a table with a workspace_id column that the registry does not name, naming it", async () => {
    const database = await scratch();
    await database.owner.unsafe("CREATE TABLE public.bookmarks_new (id uuid PRIMARY KEY, workspace_id uuid NOT NULL)");

    const findings = await inspect(database, workspacePurgeOrder);

    expect(findings).toEqual([
      {
        rule: ID,
        object: "table public.bookmarks_new",
        message: "has a workspace_id column but is not in the workspace purge registry (packages/db/src/purge-registry.ts)",
      },
    ]);
    const results = await runChecks([purgeRegistryRule], { packageDir: PACKAGE, sql: database.app, hashSqlFiles });
    expect(formatReport(results).passed).toBe(false);
    expect(formatReport(results).lines).toContain(
      "db:check: FAIL  purge-registry: table public.bookmarks_new: has a workspace_id column but is not in the workspace purge registry (packages/db/src/purge-registry.ts)",
    );
  }, HOOK_TIMEOUT_MS);

  it("does not count a column that was dropped", async () => {
    const database = await scratch();
    await database.owner.unsafe(`CREATE TABLE public.formerly (id uuid PRIMARY KEY, workspace_id uuid);
      ALTER TABLE public.formerly DROP COLUMN workspace_id`);

    expect(await inspect(database, workspacePurgeOrder)).toEqual([]);
  }, HOOK_TIMEOUT_MS);

  it("fails an entry that names no table with a workspace_id column", async () => {
    const database = await scratch();

    const findings = await inspect(database, [...workspacePurgeOrder, "no_such_table", "accounts"]);

    expect(findings).toEqual([
      { rule: ID, object: "purge registry entry no_such_table", message: "names no table of the public schema with a workspace_id column" },
      { rule: ID, object: "purge registry entry accounts", message: "names no table of the public schema with a workspace_id column" },
    ]);
  }, HOOK_TIMEOUT_MS);

  it("fails an entry for a table the purge function has no statement for", async () => {
    const database = await scratch();
    await database.owner.unsafe("CREATE TABLE public.bookmarks_new (id uuid PRIMARY KEY, workspace_id uuid NOT NULL)");

    const findings = await inspect(database, [...workspacePurgeOrder, "bookmarks_new"]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: ID, object: "purge registry entry bookmarks_new" });
    expect(findings[0]?.message).toContain("is not a table sys_workspace_purge_batch deletes from");
  }, HOOK_TIMEOUT_MS);

  it("fails every entry of a registry that is missing the shipped tables", async () => {
    const database = await scratch();

    const findings = await inspect(database, ["audit_events"]);

    expect(findings.map((finding) => finding.object).sort()).toEqual(["table public.api_tokens", "table public.workspace_members", "table public.workspace_settings"]);
  }, HOOK_TIMEOUT_MS);
});
