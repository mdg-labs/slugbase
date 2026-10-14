import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CE_CHAIN, migrate, MigrationError, migrationLevel, type MigrationChain } from "../src/migrate.ts";

// Everything that fails before the engine connects: these tests need no database.

const URL_WITH_SECRET = "postgres://slugbase_migrator:unit-test-secret@127.0.0.1:1/unused";
const root = mkdtempSync(join(tmpdir(), "slugbase-migrate-unit-"));
let counter = 0;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function chainOf(journal: unknown, files: Record<string, string> = {}, table = "migrations_unit"): MigrationChain {
  const folder = join(root, String((counter += 1)));
  mkdirSync(join(folder, "meta"), { recursive: true });
  writeFileSync(join(folder, "meta", "_journal.json"), typeof journal === "string" ? journal : JSON.stringify(journal));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(folder, name), content);
  }
  return { name: `unit${String(counter)}`, folder, bookkeepingTable: table };
}

function entry(tag: string, when: number): { idx: number; version: string; when: number; tag: string; breakpoints: boolean } {
  return { idx: 0, version: "7", when, tag, breakpoints: true };
}

async function messageOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    return (error as MigrationError).message;
  }
  throw new Error("expected the promise to reject");
}

describe("the CE chain", () => {
  it("is the committed migrations folder with the core bookkeeping table", () => {
    expect(CE_CHAIN.bookkeepingTable).toBe("migrations_core");
    expect(CE_CHAIN.folder.endsWith("/packages/db/migrations/")).toBe(true);
  });
});

describe("the database URL", () => {
  it.each(["not a url unit-test-secret", "mysql://user:unit-test-secret@host/db", ""])(
    "is refused without being echoed: %j",
    async (url) => {
      const message = await messageOf(migrate({ url }));
      expect(message).not.toContain("unit-test-secret");
      expect(await messageOf(migrationLevel({ url }))).not.toContain("unit-test-secret");
    },
  );
});

describe("chains that cannot be loaded", () => {
  const cases: [string, MigrationChain, string][] = [
    ["a folder without a journal", { name: "empty", folder: join(root, "missing"), bookkeepingTable: "migrations_unit" }, "cannot read meta/_journal.json"],
    ["a journal that is not JSON", chainOf("{"), "cannot read meta/_journal.json"],
    ["a journal without entries", chainOf({}), "no entries list"],
    ["an entry without a tag", chainOf({ entries: [{ when: 1 }] }), "without a valid tag and when"],
    ["an entry whose tag is a path", chainOf({ entries: [entry("../escape", 1)] }), "without a valid tag and when"],
    ["a journal out of order", chainOf({ entries: [entry("a", 2), entry("b", 1)] }, { "a.sql": "SELECT 1;", "b.sql": "SELECT 1;" }), "is not newer than a"],
    ["an entry without its file", chainOf({ entries: [entry("a", 1)] }), "a.sql cannot be read"],
    ["an empty migration", chainOf({ entries: [entry("a", 1)] }, { "a.sql": "\n--> statement-breakpoint\n\n" }), "holds no statement"],
  ];

  it.each(cases)("refuses %s before connecting", async (_label, chain, reason) => {
    const message = await messageOf(migrate({ url: URL_WITH_SECRET, chains: [chain] }));
    expect(message).toContain(reason);
    expect(message).not.toContain("unit-test-secret");
  });

  it("refuses a bookkeeping table that is not a plain identifier", async () => {
    const chain = chainOf({ entries: [] }, {}, 'x"; DROP TABLE y; --');
    expect(await messageOf(migrate({ url: URL_WITH_SECRET, chains: [chain] }))).toContain("not a plain lower-case identifier");
  });

  it("refuses two chains that share a name or a table", async () => {
    const first = chainOf({ entries: [] });
    expect(await messageOf(migrate({ url: URL_WITH_SECRET, chains: [first, { ...first }] }))).toContain("used by another chain");
    const second: MigrationChain = { ...chainOf({ entries: [] }), bookkeepingTable: "migrations_core" };
    expect(await messageOf(migrate({ url: URL_WITH_SECRET, chains: [second] }))).toContain("used by another chain");
  });
});

describe("loaded chains", () => {
  const loadError = "cannot read meta/_journal.json";

  it("are read once for migrationLevel, while migrate reads the folder on every call", async () => {
    const chain = chainOf({ entries: [entry("a", 1)] }, { "a.sql": "SELECT 1;" });
    // Past the load, the call fails at the connection the URL refuses.
    expect(await messageOf(migrationLevel({ url: URL_WITH_SECRET, chains: [chain] }))).not.toContain(loadError);
    rmSync(chain.folder, { recursive: true, force: true });
    expect(await messageOf(migrationLevel({ url: URL_WITH_SECRET, chains: [chain] }))).not.toContain(loadError);
    expect(await messageOf(migrate({ url: URL_WITH_SECRET, chains: [chain] }))).toContain(loadError);
  });

  it("are not kept when they fail to load", async () => {
    const chain = chainOf("{");
    expect(await messageOf(migrationLevel({ url: URL_WITH_SECRET, chains: [chain] }))).toContain(loadError);
    writeFileSync(join(chain.folder, "meta", "_journal.json"), JSON.stringify({ entries: [] }));
    expect(await messageOf(migrationLevel({ url: URL_WITH_SECRET, chains: [chain] }))).not.toContain(loadError);
  });
});
