import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatReport, runComposedDatabaseChecks, type Finding, type MigrationChain } from "../../src/testing.ts";

// A composed deployment holds its own migration chain to the database rules of
// `pnpm db:check` through the runner `@slugbase/db/testing` exports (doc 05
// sections 3.3 and 5.5). The fixture chain adds the schema `composed` with one
// system operation that follows doc 05 section 3.3 and one that breaks three of
// its rules: owned by slugbase_owner, no pinned search_path, EXECUTE granted to
// PUBLIC.

const TIMEOUT_MS = 180_000;

const FIXTURE: MigrationChain = {
  name: "composed",
  folder: join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "composed-chain"),
  bookkeepingTable: "migrations_composed",
};

const OK = "composed.sys_composed_ok";
const FAULTY = "composed.sys_composed_faulty";

const faulty = (message: string): Finding => ({ rule: "system-operations", object: "function composed.sys_composed_faulty()", message });

function findings(results: Awaited<ReturnType<typeof runComposedDatabaseChecks>>): Finding[] {
  return results.flatMap((result) => [...result.findings]);
}

describe("runComposedDatabaseChecks", () => {
  it("reports exactly the faulty composed system operation", async () => {
    const results = await runComposedDatabaseChecks({ chains: [FIXTURE], systemOperations: { registry: [OK, FAULTY] } });
    expect(results.map((result) => result.rule)).toEqual(["rls-forced", "app-owns-nothing", "system-operations"]);
    expect(findings(results)).toEqual([
      faulty("is owned by slugbase_owner, not slugbase_system"),
      faulty("does not pin SET search_path = pg_catalog, public, pg_temp"),
      faulty("has EXECUTE granted to PUBLIC"),
    ]);
    expect(formatReport(results).passed).toBe(false);
  }, TIMEOUT_MS);

  it("reports the composed functions as unregistered without their registry entries", async () => {
    const found = findings(await runComposedDatabaseChecks({ chains: [FIXTURE] }));
    expect(found).toEqual([
      { rule: "system-operations", object: "function composed.sys_composed_faulty()", message: "is SECURITY DEFINER but is not in the system operation registry (packages/db/src/system/registry.ts)" },
      { rule: "system-operations", object: "function composed.sys_composed_ok()", message: "is SECURITY DEFINER but is not in the system operation registry (packages/db/src/system/registry.ts)" },
    ]);
  }, TIMEOUT_MS);

  it("passes the core chain alone", async () => {
    const results = await runComposedDatabaseChecks({ chains: [] });
    expect(findings(results)).toEqual([]);
    expect(formatReport(results).passed).toBe(true);
  }, TIMEOUT_MS);

  it("returns a finding for every rule when the database cannot be built", async () => {
    const results = await runComposedDatabaseChecks({ chains: [{ ...FIXTURE, folder: join(FIXTURE.folder, "missing") }] });
    expect(results.map((result) => result.rule)).toEqual(["rls-forced", "app-owns-nothing", "system-operations"]);
    for (const result of results) {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.message).toContain("the rule could not run: the test database could not be built");
    }
    expect(formatReport(results).passed).toBe(false);
  }, TIMEOUT_MS);
});
